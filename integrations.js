import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// from this version on Blur my Shell follows the dock background by itself
const BMS_SELF_TRACKING_VERSION = 76;

// these are hacks to make Dash2Dock Animated compatible with other Extensions
//
export const Integrations = class {
  enable() {
    this.hookCompiz();
    this.hookBms();

    this._wmSignals = [
      global.window_manager.connect('minimize', (_, actor) =>
        this._pulseForLamp(actor, true)
      ),
      global.window_manager.connect('unminimize', (_, actor) =>
        this._pulseForLamp(actor, false)
      ),
    ];
  }

  disable() {
    this._wmSignals?.forEach((id) => global.window_manager.disconnect(id));
    this._wmSignals = null;
    this.releaseCompiz();
    this.releaseBms();
  }

  // the dock icon swells when the magic lamp swallows a window into it,
  // and when the window pours out of it again
  _pulseForLamp(actor, minimize) {
    if (!this._compiz || !this.extension.lamp_app_animation) return;
    // with tiles the window does not go into its app icon
    if (this.extension.minimize_to_tiles) return;
    if (Main.overview.visible) return;
    let meta_window = actor?.meta_window;
    if (!meta_window) return;

    let docks = this.extension.docks || [];
    let dock =
      docks.find((d) => d._monitorIndex == meta_window.get_monitor()) ??
      docks[0];
    if (!dock?.animator) return;

    let duration = 250;
    try {
      duration = this._compiz.settingsData?.DURATION?.get() ?? duration;
    } catch {
      // settings not available
    }

    if (minimize) {
      // when the bottom of the window reaches the icon
      dock.animator.pulseIcon(meta_window, {
        delay: duration * 0.55,
        duration: 320,
        amount: 0.14,
      });
    } else {
      dock.animator.pulseIcon(meta_window, {
        delay: 0,
        duration: Math.max(280, duration * 0.7),
        amount: 0.12,
      });
    }
  }

  hookCompiz(hook = true) {
    let compiz = Main.extensionManager.lookup(
      'compiz-alike-magic-lamp-effect@hermes83.github.com'
    );
    if (compiz && compiz.stateObj) {
      let stateObj = compiz.stateObj;
      this._compiz = stateObj;
      if (stateObj._getIcon && !hook) {
        stateObj.getIcon = stateObj._getIcon;
        stateObj._getIcon = null;
      }
      if (!stateObj._getIcon && hook) {
        stateObj._getIcon = stateObj.getIcon;
        if (this.extension.lamp_app_animation) {
          stateObj.getIcon = this.compiz_getIcon.bind(this);
        }
      }
    }
  }

  releaseCompiz() {
    this.hookCompiz(false);
    this._compiz = null;
  }

  // override compiz getIcon: the lamp funnels into the dock icon itself (its visible width),
  // like the macOS genie effect, instead of into a point of the screen edge
  compiz_getIcon(actor) {
    let meta_window = actor.meta_window;
    let [success, icon] = meta_window.get_icon_geometry();
    if (success) {
      return icon;
    }

    let monitor = Main.layoutManager.monitors[meta_window.get_monitor()];
    let docks = this.extension.docks;
    let dock =
      docks.find((d) => d._monitorIndex == monitor.index) ?? docks[0];
    let fallback = {
      x: monitor.x + monitor.width / 2,
      y: monitor.y + monitor.height,
      width: 0,
      height: 0,
    };
    if (!dock) {
      return fallback;
    }

    let renderer = null;
    const tiles = this.extension.minimizedTiles;
    if (tiles?.enabled) {
      // the window goes into (or comes out of) its tile before the trash; a tile made just now
      // is not drawn yet, but it takes the trash's place, which moves on
      const tile = tiles.tileFor(dock, meta_window);
      if (tile?._renderer?.visible) renderer = tile._renderer;
      else if (meta_window.minimized) renderer = dock._trashIcon?._renderer;
    }
    renderer ??= dock.findIconForWindow(meta_window)?._renderer;
    if (!renderer || !renderer.visible) {
      return fallback;
    }

    let [x, y] = renderer.get_transformed_position();
    let [w, h] = renderer.get_transformed_size();
    if (!w || !h || isNaN(x) || isNaN(y)) {
      return fallback;
    }

    // macOS-style icons draw their body on ~80% of the canvas
    let body = 0.8;
    let rect = {
      x: x + (w * (1 - body)) / 2,
      y: y + (h * (1 - body)) / 2,
      width: w * body,
      height: h * body,
    };

    // the lamp picks its direction from the screen edge the rect touches, and a magnified
    // (raised) icon is too far from it: extend the rect to the dock's screen edge, and give
    // the icon's outer edge as `clip` so the window stops in the icon instead of the edge
    let mx = monitor.x;
    let my = monitor.y;
    let mw = monitor.width;
    let mh = monitor.height;
    switch (dock._position) {
      case 'bottom':
        rect.clip = rect.y + rect.height;
        rect.height = my + mh - rect.y;
        break;
      case 'top':
        rect.clip = rect.y;
        rect.height = rect.y + rect.height - my;
        rect.y = my;
        break;
      case 'left':
        rect.clip = rect.x;
        rect.width = rect.x + rect.width - mx;
        rect.x = mx;
        break;
      case 'right':
        rect.clip = rect.x + rect.width;
        rect.width = mx + mw - rect.x;
        break;
    }
    return rect;
  }

  hookBms(hook = true) {
    if (!hook) {
      this.extension.docks.forEach((dock) => {
        dock.animator._bms = null;
      });
    }

    let bms = Main.extensionManager.lookup('blur-my-shell@aunetx');
    this._bms = bms;
    // Blur my Shell 76+ tracks the dock geometry by itself: leave it alone
    if (bms && bms.stateObj && bms.metadata.version >= 70 &&
        bms.metadata.version < BMS_SELF_TRACKING_VERSION) {
      let obj = bms.stateObj;
      if (obj._dash_to_dock_blur) {
        if (!obj._dash_to_dock_blur.update_size_orig) {
          obj._dash_to_dock_blur.update_size_orig =
            obj._dash_to_dock_blur.update_size;
        }
        if (hook && this.extension.blur_background) {
          obj._dash_to_dock_blur.update_size = () => {};
        } else if (obj._dash_to_dock_blur.update_size_orig) {
          obj._dash_to_dock_blur.update_size =
            obj._dash_to_dock_blur.update_size_orig;
        }
      }
    }
  }

  releaseBms() {
    this.hookBms(false);
    this._bms = null;
  }

  bms_update_size(animator) {
    let dock = animator.dock;

    // blur my shell
    let bms = dock.get_children().find((child) => {
      let name = child.get_name();
      return name === 'bms-dash-backgroundgroup';
    });

    animator._bms = bms;

    if (!bms) {
      return;
    }

    bms.visible = dock.extension.blur_background;
    if (!bms.visible) {
      return;
    }

    // Blur my Shell 76+ positions, sizes and rounds the blur from the dock
    // background (fake_dash._background) itself
    if (
      dock.extension.integrations._bms &&
      dock.extension.integrations._bms.metadata.version >=
        BMS_SELF_TRACKING_VERSION
    ) {
      return;
    }

    // compatible blur-my-shell version 70
    // bms version 70 supports 46,47..up
    if (
      dock.extension.integrations._bms &&
      dock.extension.integrations._bms.metadata.version >= 70
    ) {
      let bg_offset_x = dock._background.x;
      let bg_offset_y = dock._background.y;
      let rw = dock.renderArea.width;
      let rh = dock.renderArea.height;

      let meta_background = bms.first_child.first_child;
      if (!meta_background) {
        // this should exists
        return;
      }

      // bottom layout
      switch (dock._position) {
        case 'left':
        case 'top':
          bms.x = 0;
          bms.y = 0;
          bms.first_child.x = 0;
          bms.first_child.y = 0;
          bms.first_child.set_clip(
            bg_offset_x,
            bg_offset_y,
            dock._background.width - (dock.extension.border_thickness && 0),
            dock._background.height - (dock.extension.border_thickness && 0)
          );
          break;
        case 'right':
          bms.x = 0;
          bms.y = 0;
          bms.first_child.x = -meta_background.width + rw;
          bms.first_child.y = 0;
          bms.first_child.set_clip(
            -bms.first_child.x + bg_offset_x,
            0 + bg_offset_y,
            dock._background.width - (dock.extension.border_thickness && 0),
            dock._background.height - (dock.extension.border_thickness && 0)
          );
          break;
        case 'bottom':
        default:
          bms.x = 0;
          bms.y = 0;
          bms.first_child.x = 0;
          bms.first_child.y = -meta_background.height + rh;
          bms.first_child.set_clip(
            0 + bg_offset_x,
            -bms.first_child.y + bg_offset_y,
            dock._background.width - (dock.extension.border_thickness && 0),
            dock._background.height - (dock.extension.border_thickness && 0)
          );
          break;
      }

      let opacity = (dock.extension.background_color[3] ?? 0.5) * 54 + 200;
      meta_background.opacity = opacity;

      animator._blur_effects = bms.first_child.get_effects();
      if (animator._blur_effects) {
        animator._blur_effects.forEach((e) => {
          if (e.constructor.name == 'CornerEffect') {
            e.radius = dock.extension.computed_border_radius;
          }
        });
      }

      return;
    }

    // bms version incompatible
    bms.visible = false;
  }
};
