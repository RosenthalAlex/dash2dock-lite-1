import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Like the macOS Dock: a minimized window becomes a small tile (its thumbnail with the app icon
// in the corner) between the folders and the trash, the newest one next to the trash. Clicking
// the tile restores the window.

const THUMB_SIZE = 256;
const BADGE_RATIO = 0.42;
const THUMB_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'd2da', 'minimized']);
// the tile is removed a little after unminimizing, once the magic lamp has read its position
const REMOVE_DELAY_MS = 60;

export const MinimizedTiles = class {
  constructor(extension) {
    this.extension = extension;
    // meta window -> { thumbnail: path | null, order: number }
    this.entries = new Map();
    this._order = 0;
    this._signals = [];
  }

  get enabled() {
    return Boolean(this.extension.minimize_to_tiles);
  }

  enable() {
    GLib.mkdir_with_parents(THUMB_DIR, 0o755);
    this._clearThumbnails();

    const wm = global.window_manager;
    this._signals.push([wm, wm.connect('minimize', (_, actor) => this._onMinimize(actor))]);
    this._signals.push([wm, wm.connect('unminimize', (_, actor) => this._onUnminimize(actor))]);

    // windows already minimized, e.g. after a logout of the extension
    global.display.list_all_windows().forEach((w) => {
      if (w.minimized && this._accepts(w)) this._add(w);
    });
  }

  disable() {
    this._signals.forEach(([obj, id]) => obj.disconnect(id));
    this._signals = [];
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
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOVE_DELAY_MS, () => {
      if (!w.minimized) this._forget(w);
      return GLib.SOURCE_REMOVE;
    });
  }

  _add(meta_window) {
    if (this.entries.has(meta_window)) return;
    const entry = { thumbnail: null, order: ++this._order, signals: [] };
    this.entries.set(meta_window, entry);
    entry.signals.push(meta_window.connect('unmanaged', () => this._forget(meta_window)));
    entry.signals.push(
      meta_window.connect('notify::title', () => this._refreshDocks())
    );

    // the thumbnail is made from the window's own texture, before the minimize effect hides it
    this._makeThumbnail(meta_window)
      .then((path) => {
        if (!this.entries.has(meta_window)) {
          if (path) GLib.unlink(path);
          return;
        }
        entry.thumbnail = path;
        this._refreshDocks();
      })
      .catch((e) => console.error('d2da: minimized tile thumbnail', e));

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
    if (entry.thumbnail) {
      // keep the file a moment: the icon may still be drawn while the tile goes away
      const path = entry.thumbnail;
      GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
        GLib.unlink(path);
        return GLib.SOURCE_REMOVE;
      });
    }
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

    dock._minimizedTiles.forEach((tile) => {
      if (!wanted.has(tile._minimizedWindow)) {
        tile._d2daDestroyed = true;
        tile.destroy();
      }
    });
    dock._minimizedTiles = dock._minimizedTiles.filter((t) => !t._d2daDestroyed);

    windows.forEach(([w, entry]) => {
      let tile = this.tileFor(dock, w);
      const label = w.get_title() || '';
      if (tile && (tile._thumbnail !== entry.thumbnail || tile._title !== label)) {
        tile._d2daDestroyed = true;
        tile.destroy();
        dock._minimizedTiles = dock._minimizedTiles.filter((t) => t !== tile);
        tile = null;
      }
      if (!tile) {
        tile = this._createTile(dock, w, entry, label);
        dock._minimizedTiles.push(tile);
      }
    });

    // order: oldest first, the newest right before the trash
    const trash = dock._trashIcon && dock._trashIcon.get_parent() === box ? dock._trashIcon : null;
    windows.forEach(([w]) => {
      const tile = this.tileFor(dock, w);
      if (!tile) return;
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
    tile._thumbnail = entry.thumbnail;
    tile._title = label;
    tile._destroyMenu?.(); // an app menu makes no sense for a window
    tile.connect('destroy', () => (tile._d2daDestroyed = true));

    const icon = tile.child;
    const gicon = entry.thumbnail
      ? new Gio.FileIcon({ file: Gio.File.new_for_path(entry.thumbnail) })
      : app?.get_icon();
    if (icon && gicon) {
      icon._default_gicon = gicon;
      if (icon._iconActor) icon._iconActor.gicon = gicon;
    }

    tile._onClick = () => {
      meta_window.unminimize();
      meta_window.activate(global.get_current_time());
    };
    return tile;
  }

  async _makeThumbnail(meta_window) {
    const actor = meta_window.get_compositor_private();
    if (!actor) return null;
    // the window's buffer, untouched by the minimize effect; a multi-plane (e.g. YUV) buffer
    // or none at all falls back to painting the actor
    let texture = null;
    const multi = actor.get_texture?.()?.get_texture?.();
    if (multi?.get_n_planes?.() === 1) texture = multi.get_plane(0);
    else if (multi && !multi.get_n_planes) texture = multi;
    if (!texture) texture = actor.paint_to_content(null)?.get_texture();
    if (!texture) return null;

    const stream = Gio.MemoryOutputStream.new_resizable();
    const shot = await new Promise((resolve, reject) => {
      Shell.Screenshot.composite_to_stream(
        texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream,
        (_, res) => {
          try {
            resolve(Shell.Screenshot.composite_to_stream_finish(res));
          } catch (e) {
            reject(e);
          }
        }
      );
    });
    stream.close(null);
    if (!shot) return null;

    // only the window itself, without client-side shadows
    const frame = meta_window.get_frame_rect();
    const buffer = meta_window.get_buffer_rect();
    const scale = buffer.width ? shot.get_width() / buffer.width : 1;
    const cx = Math.max(0, Math.round((frame.x - buffer.x) * scale));
    const cy = Math.max(0, Math.round((frame.y - buffer.y) * scale));
    const cw = Math.min(shot.get_width() - cx, Math.round(frame.width * scale));
    const ch = Math.min(shot.get_height() - cy, Math.round(frame.height * scale));
    const win = cw > 0 && ch > 0 ? shot.new_subpixbuf(cx, cy, cw, ch) : shot;

    const canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, THUMB_SIZE, THUMB_SIZE);
    canvas.fill(0x00000000);
    const fit = (THUMB_SIZE * 0.9) / Math.max(win.get_width(), win.get_height());
    const sw = Math.max(1, Math.round(win.get_width() * fit));
    const sh = Math.max(1, Math.round(win.get_height() * fit));
    const dx = Math.round((THUMB_SIZE - sw) / 2);
    const dy = Math.round((THUMB_SIZE - sh) / 2);
    win.composite(canvas, dx, dy, sw, sh, dx, dy, fit, fit, GdkPixbuf.InterpType.BILINEAR, 255);

    const badge = this._appIconPixbuf(meta_window, Math.round(THUMB_SIZE * BADGE_RATIO));
    if (badge) {
      const bx = THUMB_SIZE - badge.get_width();
      const by = THUMB_SIZE - badge.get_height();
      badge.composite(canvas, bx, by, badge.get_width(), badge.get_height(),
        bx, by, 1, 1, GdkPixbuf.InterpType.BILINEAR, 255);
    }

    const path = GLib.build_filenamev([
      THUMB_DIR,
      `${meta_window.get_stable_sequence()}-${GLib.get_monotonic_time()}.png`,
    ]);
    canvas.savev(path, 'png', [], []);
    return path;
  }

  /// The app icon as shown in the dock (honouring the dock's icon overrides).
  _appIconPixbuf(meta_window, size) {
    const app = Shell.WindowTracker.get_default().get_window_app(meta_window);
    if (!app) return null;
    let file = null;
    const appName = app.get_id()?.replace('.desktop', '');
    const override = this.extension.app_map_cache?.[appName];
    if (override?.get_file) file = override.get_file().get_path();
    if (!file) {
      const theme = this.extension.icon_theme ?? St.IconTheme.new();
      const info = theme.lookup_by_gicon(app.get_icon(), size, St.IconLookupFlags.FORCE_SIZE);
      file = info?.get_filename();
    }
    if (!file) return null;
    try {
      return GdkPixbuf.Pixbuf.new_from_file_at_size(file, size, size);
    } catch {
      return null;
    }
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
