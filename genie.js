// Genie minimize/unminimize effect built into the dock, so that the window and the dock move as
// one: the window flies above the dock into the live position of its target (a minimized-window
// tile or the app icon), every frame. Inspired by the compiz-alike-magic-lamp-effect extension by
// Mauro Pepe (GPL-2.0-or-later).

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const X_TILES = 16;
const Y_TILES = 32;

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

    /// p: 0 = window, 1 = inside the target.
    setProgress(p) {
      // the funnel forms first, then the window pours into it
      this._k = ease(p / 0.35);
      this._j = clamp01((p - 0.08) / 0.92);
      const target = this._getTarget?.();
      if (target) this._target = target;
      this.invalidate();
    }

    vfunc_deform_vertex(width, height, v) {
      const actor = this.get_actor();
      if (!actor || !this._target) return;

      const frame = this._frame;
      const [ax, ay] = actor.get_transformed_position();
      const W = rectToFrame(frame, this._source);
      const T = rectToFrame(frame, this._target);

      // the vertex in the dock frame, as a fraction of the window (u along, v toward the dock)
      const [pa, pb] = frame.to(ax + v.tx * width, ay + v.ty * height);
      const u = (pa - W.a0) / (W.a1 - W.a0 || 1);
      const w = (pb - W.b0) / (W.b1 - W.b0 || 1);

      // slide: each row travels from its place in the window to its place in the target, the
      // rows nearest the dock first, so that the window stretches into a tail and pours in
      const LEAD = 1.4;
      const row = ease(this._j * (1 + LEAD) - LEAD * (1 - w));
      const b = lerp(W.b0 + w * (W.b1 - W.b0), T.b0 + w * (T.b1 - T.b0), row);

      // funnel: rows close to the target are squeezed to its width
      const reach = T.b0 - W.b0 || 1;
      const s = ease((b - W.b0) / reach) * this._k;
      const left = lerp(W.a0, T.a0, s);
      const right = lerp(W.a1, T.a1, s);
      const a = lerp(left, right, u);

      const [sx, sy] = frame.from(a, b);
      v.x = sx - ax;
      v.y = sy - ay;
    }

    vfunc_modify_paint_volume() {
      return false;
    }
  }
);

/// Runs the genie for a window actor: a clone flies above the dock while the window itself is
/// transparent, then `onDone` is called.
export function runGenie({ windowActor, position, getTarget, minimize, duration, onFrame, onDone }) {
  const [x, y] = windowActor.get_transformed_position();
  const [w, h] = windowActor.get_transformed_size();

  const clone = new Clutter.Clone({ source: windowActor, x, y, width: w, height: h });
  Main.layoutManager.uiGroup.add_child(clone);
  const originalOpacity = windowActor.opacity;
  windowActor.opacity = 0;

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
    windowActor.opacity = originalOpacity;
    onDone?.();
  };
  timeline.connect('completed', finish);
  frame();
  timeline.start();
  return { cancel: finish };
}
