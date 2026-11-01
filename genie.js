// Genie minimize/unminimize effect built into the dock, so that the window and the dock move as
// one: the window flies above the dock into the live position of its target (a minimized-window
// tile or the app icon), every frame. Inspired by the compiz-alike-magic-lamp-effect extension by
// Mauro Pepe (GPL-2.0-or-later).

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const X_TILES = 16;
const Y_TILES = 32;
// how much earlier the rows nearest the dock set off
const LEAD = 1.4;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// smooth start and end, like the macOS genie
function ease(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/// Converts between stage coordinates and a frame where `b` grows toward the dock edge and `a`
/// runs along it, so that one genie works for docks on any side.
function makeFrame(position) {
  switch (position) {
    case 'top':
      return { to: (x, y) => [x, -y], from: (a, b) => [a, -b] };
    case 'left':
      return { to: (x, y) => [y, -x], from: (a, b) => [-b, a] };
    case 'right':
      return { to: (x, y) => [y, x], from: (a, b) => [b, a] };
    default:
      return { to: (x, y) => [x, y], from: (a, b) => [a, b] };
  }
}

function rectToFrame(frame, r) {
  const [a1, b1] = frame.to(r.x, r.y);
  const [a2, b2] = frame.to(r.x + r.width, r.y + r.height);
  return {
    a0: Math.min(a1, a2), a1: Math.max(a1, a2),
    b0: Math.min(b1, b2), b1: Math.max(b1, b2),
  };
}

export const GenieEffect = GObject.registerClass(
  class GenieEffect extends Clutter.DeformEffect {
    _init(params) {
      super._init();
      this._position = params.position ?? 'bottom';
      this._getTarget = params.getTarget; // () => stage rect {x, y, width, height} | null
      this._frame = makeFrame(this._position);
      this._source = params.source; // stage rect of the window when the effect starts
      this._k = 0; // how much the funnel has formed
      this._j = 0; // how far the window has slid into the target
      this._target = null;
      this.set_n_tiles(X_TILES, Y_TILES);
    }

    /// p: 0 = window, 1 = inside the target. Everything that does not depend on the vertex is
    /// computed here, once per frame: deform_vertex runs for every vertex of the mesh.
    setProgress(p) {
      // the funnel forms first, then the window pours into it
      this._k = ease(p / 0.35);
      this._j = clamp01((p - 0.08) / 0.92);
      const target = this._getTarget?.();
      if (target) this._target = target;
      if (this._target) {
        // the clone sits exactly where the window was, so its origin is the source's
        this._W = rectToFrame(this._frame, this._source);
        this._T = rectToFrame(this._frame, this._target);
        this._reach = this._T.b0 - this._W.b0 || 1;
      }
      this.invalidate();
    }

    vfunc_deform_vertex(width, height, v) {
      const W = this._W;
      const T = this._T;
      if (!W || !T) return;

      // the vertex as a fraction of the window: u along the dock edge, w toward it
      let u, w;
      switch (this._position) {
        case 'top': u = v.tx; w = 1 - v.ty; break;
        case 'left': u = v.ty; w = 1 - v.tx; break;
        case 'right': u = v.ty; w = v.tx; break;
        default: u = v.tx; w = v.ty;
      }

      // slide: each row travels from its place in the window to its place in the target, the
      // rows nearest the dock first, so that the window stretches into a tail and pours in
      const row = ease(this._j * (1 + LEAD) - LEAD * (1 - w));
      const b = lerp(W.b0 + w * (W.b1 - W.b0), T.b0 + w * (T.b1 - T.b0), row);

      // funnel: rows close to the target are squeezed to its width
      const s = ease((b - W.b0) / this._reach) * this._k;
      const a = lerp(lerp(W.a0, T.a0, s), lerp(W.a1, T.a1, s), u);

      const [sx, sy] = this._frame.from(a, b);
      v.x = sx - this._source.x;
      v.y = sy - this._source.y;
    }

    vfunc_modify_paint_volume() {
      return false;
    }
  }
);

/// The shadow that the Rounded Window Corners extension draws for a window, as a separate actor
/// below it, or null when the extension is not active for this window.
function roundedCornersShadowOf(windowActor) {
  const shadow = windowActor.rwcCustomData?.shadow;
  return shadow && shadow.get_stage() ? shadow : null;
}

/// Runs the genie for a window actor: a clone flies above the dock while the window itself is
/// transparent, then `onDone` is called.
export function runGenie({ windowActor, position, getTarget, minimize, duration, onFrame, onDone }) {
  const [x, y] = windowActor.get_transformed_position();
  const [w, h] = windowActor.get_transformed_size();

  const clone = new Clutter.Clone({ source: windowActor, x, y, width: w, height: h });
  Main.layoutManager.uiGroup.add_child(clone);
  const originalOpacity = windowActor.opacity;
  const shadow = roundedCornersShadowOf(windowActor);
  const originalShadowOpacity = shadow?.opacity;
  windowActor.opacity = 0;
  // Rounded Window Corners keeps its shadow on a sibling actor in windowGroup; hide it while the
  // window is in flight so it neither stays behind on minimize nor waits at the destination on
  // unminimize
  let shadowDestroyId = 0;
  if (shadow) {
    shadow.opacity = 0;
    shadowDestroyId = shadow.connect('destroy', () => (shadowDestroyId = 0));
  }

  const effect = new GenieEffect({
    position,
    getTarget,
    source: { x, y, width: w, height: h },
  });
  clone.add_effect_with_name('d2da-genie', effect);

  const timeline = new Clutter.Timeline({ actor: clone, duration });
  const frame = () => {
    const t = timeline.get_progress();
    const p = minimize ? t : 1 - t;
    effect.setProgress(p);
    onFrame?.(p);
  };
  timeline.connect('new-frame', frame);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    timeline.stop();
    clone.destroy();
    onDone?.();
    windowActor.opacity = originalOpacity;
    if (shadowDestroyId) {
      shadow.disconnect(shadowDestroyId);
      shadow.opacity = originalShadowOpacity;
    }
  };
  timeline.connect('completed', finish);
  frame();
  timeline.start();
  return { cancel: finish };
}
