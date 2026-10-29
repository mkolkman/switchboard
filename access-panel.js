/**
 * access-panel.js: a small panel right under a macOS or 1Password dialog,
 * saying which session asks and why (access-watch.js finds both, the window
 * names the session). It floats over every app, never takes the focus and
 * lets every click through: it only informs, the dialog decides.
 *
 * macOS shows its privacy dialogs from UserNotificationCenter; 1Password's
 * approval is a floating window of its own. Their place comes from the
 * window list (CGWindowListCopyWindowInfo through osascript), which needs no
 * permission as long as no window titles are read.
 */

const { BrowserWindow, screen } = require('electron');
const { execFile } = require('child_process');
const path = require('path');

const PANEL_WIDTH = 520;
// A first guess per row; the page measures itself and reports its height.
const ROW_HEIGHT = 64;
const PANEL_PAD = 12;
const MAX_HEIGHT = 420;
const GAP = 10;
const MAX_ROWS = 4;
// How long to look for the dialog after a request: it shows within a split second.
const FIND_MS = 3000;

// Prints the bounds of the dialog windows of the given owners as JSON, once
// they hold still or the time is up: any window of UserNotificationCenter,
// and a floating one (layer above 0) of 1Password, whose main window may be
// open too. A macOS dialog grows in as it opens (14x14 to 260x250 in about
// 0.4 s, overshooting on the way), so its first bounds are not its last.
const FIND_SCRIPT = `
ObjC.import('CoreGraphics');
function dialogs(owners) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    const owner = w.objectForKey('kCGWindowOwnerName').js;
    const layer = w.objectForKey('kCGWindowLayer').js;
    if (!owners.includes(owner) || (owner !== 'UserNotificationCenter' && layer <= 0)) continue;
    const b = w.objectForKey('kCGWindowBounds');
    const r = { owner, x: b.objectForKey('X').js, y: b.objectForKey('Y').js, width: b.objectForKey('Width').js, height: b.objectForKey('Height').js };
    if (r.width > 40 && r.height > 40) out.push(r);
  }
  return out;
}
function run(argv) {
  const end = Date.now() + Number(argv[0]);
  const owners = argv.slice(1);
  let last = '';
  let same = 0;
  for (;;) {
    const found = dialogs(owners);
    const now = JSON.stringify(found);
    same = found.length && now === last ? same + 1 : 0;
    last = now;
    if (same >= 3 || Date.now() > end) return now;
    delay(0.06);
  }
}`;

/** Where the panel goes: centred just under the dialog, else above it, else at the top of the screen. */
function panelBounds(dialog, height, workArea) {
  if (!dialog) {
    return { x: Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2), y: workArea.y + 40, width: PANEL_WIDTH, height };
  }
  const x = Math.round(dialog.x + dialog.width / 2 - PANEL_WIDTH / 2);
  const below = dialog.y + dialog.height + GAP;
  const y = below + height <= workArea.y + workArea.height ? below : Math.max(workArea.y, dialog.y - GAP - height);
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - PANEL_WIDTH),
    y: Math.round(y), width: PANEL_WIDTH, height,
  };
}

function panelHeight(rows) {
  return PANEL_PAD * 2 + Math.min(rows, MAX_ROWS) * ROW_HEIGHT;
}

class AccessPanel {
  constructor({ log = console } = {}) {
    this.log = log;
    this.win = null;
    this.rows = [];
    this.placedFor = null; // the request the panel was last placed for
    this.dialog = null; // where that request's dialog is, or null
    this.workArea = null;
    this.height = panelHeight(1);
    this.ready = null;
  }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: PANEL_WIDTH, height: panelHeight(1), show: false, frame: false, transparent: true,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'access-panel-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    // Above other apps' windows, on every desktop and over a full-screen app.
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Nothing to click: a click lands on whatever is under it.
    this.win.setIgnoreMouseEvents(true);
    this.ready = this.win.loadFile(path.join(__dirname, 'public', 'access-panel.html')).catch(err => this.log.warn?.(`[access] panel: ${err.message}`));
    this.win.on('closed', () => { this.win = null; });
    return this.win;
  }

  /**
   * The rows the main window's banner shows, newest request first: { id,
   * sessionId, title, asks, command, count, kind }. None hides the panel.
   */
  async update(rows) {
    this.rows = (rows || []).slice(0, MAX_ROWS);
    if (!this.rows.length) {
      this.placedFor = null;
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const win = this.window();
    await this.ready;
    if (win.isDestroyed()) return;
    win.webContents.send('access-panel-rows', this.rows);
    const latest = this.rows[0];
    if (this.placedFor !== latest.id) {
      this.placedFor = latest.id;
      const dialog = await findDialog(latest.kind === 'op' ? ['1Password', 'UserNotificationCenter'] : ['UserNotificationCenter']);
      if (win.isDestroyed() || this.placedFor !== latest.id) return;
      const near = dialog ? { x: dialog.x + dialog.width / 2, y: dialog.y } : screen.getCursorScreenPoint();
      this.dialog = dialog;
      this.workArea = screen.getDisplayNearestPoint(near).workArea;
      this.place();
    }
    if (!win.isVisible()) win.showInactive();
  }

  /** The page's own height, once it has laid out its rows (wrapped text); the top stays under the dialog. */
  resize(height) {
    const h = Math.min(Math.max(Math.round(Number(height) || 0), 40), MAX_HEIGHT);
    if (h === this.height) return;
    this.height = h;
    this.place();
  }

  place() {
    if (!this.win || this.win.isDestroyed() || !this.workArea) return;
    this.win.setBounds(panelBounds(this.dialog, this.height, this.workArea));
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/** The newest dialog window of these owners, or null when none shows in time. */
function findDialog(owners) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FIND_SCRIPT, String(FIND_MS), ...owners], { timeout: FIND_MS + 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const found = JSON.parse(String(stdout).trim() || '[]');
        // 1Password's own dialog before a macOS one, when both are up.
        resolve(found.find(w => w.owner === owners[0]) || found[0] || null);
      } catch { resolve(null); }
    });
  });
}

module.exports = { AccessPanel, panelBounds, panelHeight, PANEL_WIDTH };
