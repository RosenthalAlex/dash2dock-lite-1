import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GdkPixbuf from 'gi://GdkPixbuf';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Like the macOS Dock: a minimized window becomes a small tile (a live picture of the window with
// the app icon in the corner) between the folders and the trash, the newest one next to the
// trash. Clicking the tile restores the window.
//
// The picture is a clone of the window drawn over the tile's (empty) dock icon, following it
// every frame: nothing is read back from the GPU, so minimizing does not stutter.

const BADGE_RATIO = 0.42;
const BADGE_ICON_SIZE = 96;
const PICTURE_RATIO = 0.9;
const THUMB_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'd2da', 'minimized']);
// the tile is removed a little after unminimizing, once the magic lamp has read its position
const REMOVE_DELAY_MS = 60;
// how long after a window's minimized state changes the tiles check that they follow it: by then
// the Shell's (un)minimize signal and the genie have started, if there is one at all (there is none
// in the overview, or for a window on another workspace)
const SETTLE_MS = 300;

function popIn(badge) {
  if (!badge) return;
  badge.remove_all_transitions();
  badge.set_scale(0.2, 0.2);
  badge.opacity = 0;
  badge.ease({
    scale_x: 1.18, scale_y: 1.18, opacity: 255, duration: 170,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    onComplete: () => badge.ease({
      scale_x: 1, scale_y: 1, duration: 150, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
    }),
  });
}

function popOut(badge) {
  if (!badge) return;
  badge.remove_all_transitions();
  badge.ease({
    scale_x: 0.2, scale_y: 0.2, opacity: 0, duration: 200,
    mode: Clutter.AnimationMode.EASE_IN_QUAD,
  });
}

export const MinimizedTiles = class {
  constructor(extension) {
    this.extension = extension;
    // meta window -> { order: number, reveal: 0..1, signals }
    this.entries = new Map();
    this._order = 0;
    this._signals = [];
    this._windowSignals = new Map(); // meta window -> signal ids
    this._timeouts = new Set();
  }

  get enabled() {
    return Boolean(this.extension.minimize_to_tiles);
  }

  enable() {
    GLib.mkdir_with_parents(THUMB_DIR, 0o755);
    this._clearThumbnails();
    // the tiles' dock icon is empty: the window's picture is drawn over it
    this._blank = GLib.build_filenamev([THUMB_DIR, 'blank.png']);
    const blank = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 8, 8);
    blank.fill(0x00000000);
    blank.savev(this._blank, 'png', [], []);

    const wm = global.window_manager;
    this._signals.push([wm, wm.connect('minimize', (_, actor) => this._onMinimize(actor))]);
    this._signals.push([wm, wm.connect('unminimize', (_, actor) => this._onUnminimize(actor))]);

    // the minimized state itself is followed too: the Shell does not always signal it
    this._signals.push([
      global.display,
      global.display.connect('window-created', (_, w) => this._watch(w)),
    ]);

    // windows already minimized, e.g. after a logout of the extension
    global.display.list_all_windows().forEach((w) => {
      this._watch(w);
      if (w.minimized && this._accepts(w)) this._add(w, true);
    });
  }

  _watch(meta_window) {
    if (this._windowSignals.has(meta_window)) return;
    this._windowSignals.set(meta_window, [
      meta_window.connect('notify::minimized', () => this._settleLater(meta_window)),
      meta_window.connect('unmanaged', () => this._unwatch(meta_window)),
    ]);
  }

  _unwatch(meta_window) {
    const ids = this._windowSignals.get(meta_window);
    if (!ids) return;
    this._windowSignals.delete(meta_window);
    ids.forEach((id) => {
      try {
        meta_window.disconnect(id);
      } catch {
        // window already gone
      }
    });
  }

  _settleLater(meta_window) {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
      this._timeouts.delete(id);
      if (this._windowSignals.has(meta_window)) this._settle(meta_window);
      return GLib.SOURCE_REMOVE;
    });
    this._timeouts.add(id);
  }

  /// Makes the tiles match the window's minimized state when no animation took care of it: a
  /// window restored from the overview or on another workspace must not leave its tile behind.
  _settle(meta_window) {
    const running = this.extension.genieController?.isRunning?.(meta_window);
    if (meta_window.minimized) {
      if (!this.entries.has(meta_window) && this._accepts(meta_window)) this._add(meta_window, true);
      else if (!running) this.reveal(meta_window, 1);
    } else if (this.entries.has(meta_window) && !running) {
      this._forget(meta_window);
    }
  }

  disable() {
    this._signals.forEach(([obj, id]) => obj.disconnect(id));
    this._signals = [];
    this._timeouts.forEach((id) => GLib.source_remove(id));
    this._timeouts.clear();
    [...this._windowSignals.keys()].forEach((w) => this._unwatch(w));
    [...this.entries.keys()].forEach((w) => this._forget(w));
    this._clearThumbnails();
  }

  _accepts(meta_window) {
    return (
      this.enabled &&
      !meta_window.skip_taskbar &&
      meta_window.get_window_type() === 0 /* Meta.WindowType.NORMAL */
    );
  }

  _onMinimize(actor) {
    const w = actor?.meta_window;
    if (w && this._accepts(w)) this._add(w);
  }

  _onUnminimize(actor) {
    const w = actor?.meta_window;
    if (!w || !this.entries.has(w)) return;
    // the dock's genie removes the tile when the window is out (restored())
    if (this.extension.genieController?.enabled) return;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOVE_DELAY_MS, () => {
      if (!w.minimized) this._forget(w);
      return GLib.SOURCE_REMOVE;
    });
  }

  /// The genie has put the window into its tile: the picture is in, the app icon pops in.
  landed(meta_window) {
    this.reveal(meta_window, 1);
    this._eachOverlay(meta_window, (overlay) => popIn(overlay._badge));
  }

  /// The genie has brought the window back out of its tile.
  restored(meta_window) {
    if (!meta_window.minimized) this._forget(meta_window);
  }

  /// The window pours out of its tile: the picture goes and the app icon shrinks away.
  emptyTile(dock, meta_window) {
    const entry = this.entries.get(meta_window);
    if (entry) entry.reveal = 0;
    this._eachOverlay(meta_window, (overlay) => {
      overlay._picture?.ease({ opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
      popOut(overlay._badge);
    });
  }

  /// How much of the window's picture shows in its tile (0..1).
  reveal(meta_window, amount) {
    const entry = this.entries.get(meta_window);
    if (!entry) return;
    entry.reveal = amount;
    this._eachOverlay(meta_window, (overlay) => {
      if (overlay._picture) {
        overlay._picture.remove_all_transitions();
        overlay._picture.opacity = Math.round(255 * amount);
      }
    });
  }

  _eachOverlay(meta_window, fn) {
    (this.extension.docks || []).forEach((dock) => {
      const overlay = this.tileFor(dock, meta_window)?._overlay;
      if (overlay) fn(overlay);
    });
  }

  _add(meta_window, already_hidden = false) {
    if (this.entries.has(meta_window)) return;
    const entry = { order: ++this._order, reveal: 1, signals: [] };
    this.entries.set(meta_window, entry);
    entry.signals.push(meta_window.connect('unmanaged', () => this._forget(meta_window)));
    entry.signals.push(
      meta_window.connect('notify::title', () => this._refreshDocks())
    );

    // without the dock's genie (or for windows already minimized) the picture shows at once;
    // the genie reveals it as the window lands
    entry.reveal = this.extension.genieController?.enabled && !already_hidden ? 0 : 1;

    this._refreshDocks();
  }

  _forget(meta_window) {
    const entry = this.entries.get(meta_window);
    if (!entry) return;
    entry.signals.forEach((id) => {
      try {
        meta_window.disconnect(id);
      } catch {
        // window already gone
      }
    });
    this.entries.delete(meta_window);
    this._refreshDocks();
  }

  _refreshDocks() {
    (this.extension.docks || []).forEach((dock) => {
      dock._updateExtraIcons?.();
      dock._icons = null;
      dock._needsLayout = true;
    });
    this.extension.animate?.({ refresh: true });
  }

  /// The tile of a window in a dock, if any.
  tileFor(dock, meta_window) {
    return (dock._minimizedTiles || []).find((t) => t._minimizedWindow === meta_window) ?? null;
  }

  /// Keeps the tiles of a dock in line with the minimized windows, just before the trash.
  reconcile(dock) {
    const box = dock._extraIcons;
    if (!box) return;
    dock._minimizedTiles = (dock._minimizedTiles || []).filter((t) => !t._d2daDestroyed);

    const windows = this.enabled
      ? [...this.entries.entries()]
          .filter(([w]) => this._dockFor(w) === dock)
          .sort((a, b) => a[1].order - b[1].order)
      : [];
    const wanted = new Set(windows.map(([w]) => w));
    const created = [];

    dock._minimizedTiles.forEach((tile) => {
      if (!wanted.has(tile._minimizedWindow)) this._closeTile(dock, tile);
    });
    dock._minimizedTiles = dock._minimizedTiles.filter((t) => !t._d2daDestroyed && !t._closing);

    windows.forEach(([w, entry]) => {
      let tile = this.tileFor(dock, w);
      const label = w.get_title() || '';
      // a new title updates the tile in place: no relayout of the dock
      if (tile && tile._title !== label) {
        tile.setLabelText?.(label);
        tile._title = label;
      }
      if (!tile) {
        tile = this._createTile(dock, w, entry, label);
        dock._minimizedTiles.push(tile);
        created.push(tile);
      }
    });

    // a new tile goes right before the trash (the newest next to it); tiles already in the dock
    // stay where they are, so that a closing tile's slot shrinks in place and the others never
    // hop over it
    const trash = dock._trashIcon && dock._trashIcon.get_parent() === box ? dock._trashIcon : null;
    created.forEach((tile) => {
      box.remove_child(tile);
      if (trash) box.insert_child_below(tile, trash);
      else box.add_child(tile);
    });
  }

  _dockFor(meta_window) {
    const docks = this.extension.docks || [];
    return docks.find((d) => d._monitorIndex == meta_window.get_monitor()) ?? docks[0] ?? null;
  }

  _createTile(dock, meta_window, entry, label) {
    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.get_window_app(meta_window);
    const name = (label || app?.get_name() || 'Window').replace(/[\r\n]/g, ' ');
    const kf = new GLib.KeyFile();
    const content =
      `[Desktop Entry]\nType=Application\nName=${name}\nExec=true\nNoDisplay=true\n` +
      `StartupWMClass=d2da-minimized\n`;
    kf.load_from_data(content, new TextEncoder().encode(content).length, GLib.KeyFileFlags.NONE);
    const appInfo = (GioUnix?.DesktopAppInfo ?? Gio.DesktopAppInfo).new_from_keyfile(kf);

    const tile = dock.createItem(appInfo, `_minimized_${meta_window.get_stable_sequence()}`);
    tile._minimizedWindow = meta_window;
    tile._title = label;
    tile._destroyMenu?.(); // an app menu makes no sense for a window

    // the dock draws an empty icon; the window's picture is drawn over it
    const icon = tile.child;
    const gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(this._blank) });
    if (icon) {
      icon._default_gicon = gicon;
      if (icon._iconActor) icon._iconActor.gicon = gicon;
    }

    const overlay = this._createOverlay(meta_window, app);
    const revealed = (entry.reveal ?? 1) > 0;
    if (overlay._picture) overlay._picture.opacity = revealed ? 255 : 0;
    if (!revealed) {
      overlay._badge.opacity = 0;
      overlay._badge.set_scale(0, 0);
    }
    // the dock makes room for the tile, like the macOS Dock, instead of the trash jumping aside
    if (!revealed) this._animateSlot(dock, tile, 0, 1, this._openDuration());
    dock.renderArea?.add_child(overlay);
    tile._overlay = overlay;
    // called by the animator each time it places the tile's renderer
    tile._followRenderer = (renderer) => this._placeOverlay(overlay, renderer, meta_window);
    // the overlay can go first, with the dock's render area (e.g. when the dock is rebuilt)
    overlay.connect('destroy', () => (overlay._gone = true));
    tile.connect('destroy', () => {
      tile._d2daDestroyed = true;
      tile._followRenderer = null;
      tile._slotTimeline?.stop();
      if (!overlay._gone) overlay.destroy();
    });

    tile._onClick = () => {
      meta_window.unminimize();
      meta_window.activate(global.get_current_time());
    };
    return tile;
  }

  _openDuration() {
    return Math.max(200, (this.extension.genie_duration || 400) * 0.85);
  }

  /// Animates the width of a tile's slot in the dock (0 = closed, 1 = open).
  _animateSlot(dock, tile, from, to, duration, onDone) {
    tile._slotTimeline?.stop();
    tile._slotFactor = from;
    const timeline = new Clutter.Timeline({ actor: tile, duration });
    tile._slotTimeline = timeline;
    const apply = () => {
      if (tile._d2daDestroyed) return;
      const t = timeline.get_progress();
      const e = 1 - (1 - t) * (1 - t) * (1 - t); // ease out
      tile._slotFactor = from + (to - from) * e;
      if (dock._itemSize) tile.width = dock._itemSize * tile._slotFactor;
      dock._beginAnimation?.();
    };
    timeline.connect('new-frame', apply);
    timeline.connect('completed', () => {
      tile._slotTimeline = null;
      tile._slotFactor = to === 1 ? undefined : to;
      if (dock._itemSize) tile.width = dock._itemSize * (tile._slotFactor ?? 1);
      dock._beginAnimation?.();
      onDone?.();
    });
    apply();
    timeline.start();
  }

  /// The tile's window is back: its slot closes, then it goes.
  _closeTile(dock, tile) {
    if (tile._closing || tile._d2daDestroyed) return;
    tile._closing = true;
    tile._overlay?.hide();
    this._animateSlot(dock, tile, tile._slotFactor ?? 1, 0, 260, () => {
      if (tile._d2daDestroyed) return;
      tile._d2daDestroyed = true;
      tile.destroy();
      dock._icons = null;
      dock._needsLayout = true;
      dock._beginAnimation?.();
    });
  }

  /// The live picture of a window with its app icon in the corner, drawn over its tile.
  _createOverlay(meta_window, app) {
    const overlay = new St.Widget({ reactive: false, layout_manager: new Clutter.FixedLayout() });
    const windowActor = meta_window.get_compositor_private();
    if (windowActor) {
      overlay._picture = new Clutter.Clone({ source: windowActor });
      overlay.add_child(overlay._picture);
    }
    // the box follows the tile; the icon inside it has its own pop in / out animation
    overlay._badgeBox = new St.Widget({ layout_manager: new Clutter.FixedLayout() });
    overlay._badge = new St.Icon({
      gicon: this._appGicon(app),
      icon_size: BADGE_ICON_SIZE,
      pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
    });
    overlay._badgeBox.add_child(overlay._badge);
    overlay.add_child(overlay._badgeBox);
    overlay.hide(); // until the animator first places it
    return overlay;
  }

  _placeOverlay(overlay, renderer, meta_window) {
    if (!renderer?.visible) {
      overlay.hide();
      return;
    }
    overlay.show();
    const size = renderer.width * renderer.scaleX;
    overlay.set_position(renderer.x + renderer.translationX, renderer.y + renderer.translationY);
    overlay.set_size(size, size);

    // the window, without its shadows, fitted in the tile
    const picture = overlay._picture;
    const windowActor = meta_window.get_compositor_private();
    if (picture && windowActor) {
      const frame = meta_window.get_frame_rect();
      const buffer = meta_window.get_buffer_rect();
      const fw = frame.width || windowActor.width;
      const fh = frame.height || windowActor.height;
      const fit = (size * PICTURE_RATIO) / Math.max(fw, fh, 1);
      // the clone shows the whole buffer: scale it so that the frame part fits, and offset it
      picture.set_size(buffer.width * fit, buffer.height * fit);
      picture.set_position(
        (size - fw * fit) / 2 - (frame.x - buffer.x) * fit,
        (size - fh * fit) / 2 - (frame.y - buffer.y) * fit
      );
    }

    // loaded once at a fixed size and scaled: changing icon_size would reload it every frame
    const box = overlay._badgeBox;
    const bs = size * BADGE_RATIO;
    box.set_position(size - bs, size - bs);
    box.set_scale(bs / BADGE_ICON_SIZE, bs / BADGE_ICON_SIZE);
  }

  /// The app icon as shown in the dock (honouring the dock's icon overrides).
  _appGicon(app) {
    if (!app) return null;
    const appName = app.get_id()?.replace('.desktop', '');
    return this.extension.app_map_cache?.[appName] ?? app.get_icon();
  }

  _clearThumbnails() {
    const dir = Gio.File.new_for_path(THUMB_DIR);
    try {
      const children = dir.enumerate_children('standard::name', 0, null);
      let info;
      while ((info = children.next_file(null)))
        dir.get_child(info.get_name()).delete(null);
    } catch {
      // nothing to clear
    }
  }
};
