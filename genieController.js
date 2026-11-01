import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { runGenie } from './genie.js';

// Takes over the minimize/unminimize animations of the Shell and runs the dock's genie: the
// window flies into the live position of its tile (or app icon) and comes back out of it.

// macOS-style icons draw their body on ~80% of the canvas
const ICON_BODY = 0.8;

export const GenieController = class {
  constructor(extension) {
    this.extension = extension;
    this._running = new Map(); // window actor -> genie handle
  }

  get enabled() {
    return Boolean(this.extension.genie_effect);
  }

  enable() {
    const shellwm = Main.wm._shellwm;
    this._origCompletedMinimize = shellwm.completed_minimize;
    this._origCompletedUnminimize = shellwm.completed_unminimize;
    this._origShouldAnimate = Main.wm._shouldAnimateActor;

    const self = this;
    // the Shell completes (un)minimizing at once when it does not animate: hold it until the
    // genie is done
    // (the Shell's handler runs before ours in the same signal emission, so while the genie is
    // on, completing is always ours to do)
    shellwm.completed_minimize = function (actor) {
      if (self.enabled) return;
      return self._origCompletedMinimize.call(this, actor);
    };
    shellwm.completed_unminimize = function (actor) {
      if (self.enabled) return;
      return self._origCompletedUnminimize.call(this, actor);
    };
    Main.wm._shouldAnimateActor = function (actor, types) {
      if (self.enabled && !Main.overview.visible) {
        const stack = new Error().stack ?? '';
        if (stack.includes('_minimizeWindow') || stack.includes('_unminimizeWindow'))
          return false;
      }
      return self._origShouldAnimate.call(this, actor, types);
    };

    const wm = global.window_manager;
    // connected before the Shell's own handlers run their "completed" calls in the same emission
    this._signals = [
      wm.connect('minimize', (_, actor) => this._onMinimize(actor)),
      wm.connect('unminimize', (_, actor) => this._onUnminimize(actor)),
    ];
  }

  disable() {
    this._signals?.forEach((id) => global.window_manager.disconnect(id));
    this._signals = null;
    [...this._running.values()].forEach((handle) => handle.cancel());
    this._running.clear();
    const shellwm = Main.wm._shellwm;
    if (this._origCompletedMinimize) shellwm.completed_minimize = this._origCompletedMinimize;
    if (this._origCompletedUnminimize) shellwm.completed_unminimize = this._origCompletedUnminimize;
    if (this._origShouldAnimate) Main.wm._shouldAnimateActor = this._origShouldAnimate;
  }

  _duration() {
    return Math.max(150, this.extension.genie_duration || 420);
  }

  _dockFor(meta_window) {
    const docks = this.extension.docks || [];
    return docks.find((d) => d._monitorIndex == meta_window.get_monitor()) ?? docks[0] ?? null;
  }

  /// The visible rect of a dock item (its renderer), as the genie target.
  _rectOf(item) {
    const renderer = item?._renderer;
    if (!renderer || !renderer.visible) return null;
    const [x, y] = renderer.get_transformed_position();
    const [w, h] = renderer.get_transformed_size();
    if (!w || !h || isNaN(x) || isNaN(y)) return null;
    return {
      x: x + (w * (1 - ICON_BODY)) / 2,
      y: y + (h * (1 - ICON_BODY)) / 2,
      width: w * ICON_BODY,
      height: h * ICON_BODY,
    };
  }

  _target(dock, meta_window) {
    const tiles = this.extension.minimizedTiles;
    if (tiles?.enabled) {
      const tile = tiles.tileFor(dock, meta_window);
      // a tile made just now is not drawn yet: it takes the trash's place
      const rect = (tile?._renderer?.visible && this._rectOf(tile)) || this._rectOf(dock._trashIcon);
      if (rect) return rect;
    }
    const icon = dock.findIconForWindow(meta_window);
    const rect = this._rectOf(icon);
    if (rect) return rect;
    const m = dock._monitor ?? Main.layoutManager.primaryMonitor;
    return { x: m.x + m.width / 2 - 24, y: m.y + m.height - 48, width: 48, height: 48 };
  }

  _start(actor, minimize) {
    const meta_window = actor.meta_window;
    const dock = this._dockFor(meta_window);
    if (!dock || Main.overview.visible) return false;

    // the dock shows itself while a window goes in or out of it
    const autohider = dock.autohider;
    if (this.extension.autohide_dash && autohider && !autohider._shown) autohider.show();

    this._running.get(actor)?.cancel();
    const tiles = this.extension.minimizedTiles;
    if (!minimize) tiles?.emptyTile(dock, meta_window);

    const handle = runGenie({
      windowActor: actor,
      position: dock._position,
      getTarget: () => this._target(dock, meta_window),
      minimize,
      duration: this._duration(),
      // the window's picture appears in its tile as the window lands
      onFrame: minimize ? (p) => tiles?.reveal(meta_window, Math.max(0, (p - 0.8) / 0.2)) : null,
      onDone: () => {
        this._running.delete(actor);
        if (minimize) {
          this._origCompletedMinimize.call(Main.wm._shellwm, actor);
          tiles?.landed(meta_window);
          if (!tiles?.enabled) dock.animator?.pulseIcon?.(meta_window, { duration: 300 });
        } else {
          this._origCompletedUnminimize.call(Main.wm._shellwm, actor);
          tiles?.restored(meta_window);
        }
        autohider?._debounceCheckHide?.();
      },
    });
    this._running.set(actor, handle);
    return true;
  }

  _onMinimize(actor) {
    if (!this.enabled || !actor?.meta_window) return;
    if (!this._start(actor, true)) this._origCompletedMinimize.call(Main.wm._shellwm, actor);
  }

  _onUnminimize(actor) {
    if (!this.enabled || !actor?.meta_window) return;
    actor.show();
    if (!this._start(actor, false)) this._origCompletedUnminimize.call(Main.wm._shellwm, actor);
  }
};
