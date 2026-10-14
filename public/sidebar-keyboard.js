// --- Keyboard: shortcuts that start and archive sessions ---
// Cmd+L moves into the session list (below), Cmd+A opens the new-session
// picker, Cmd+E archives the open session and Cmd+N starts a quick session
// (a bare N too, outside the terminal and text fields). In a text field Cmd+A
// and Cmd+E stay its own (Select All). A quick session is Claude in one fixed
// folder, the global quickSessionPath setting; until that is set the keys
// open Settings.
// Ported from Joris Blaak's fork (ec9bf71, 98ec26a).
// Depends on: dialogs.js (showProjectPickerDialog, resolveDefaultSessionOptions),
// app.js (launchWithDefaultCli, activeSessionId, sessionMap), projects-view.js
// (toggleArchiveSession), sidebar.js (startRename), utils.js (encodeProjectPath).

const sidebarKeyboardMac = typeof window !== 'undefined' && window.api && window.api.platform === 'darwin';

/** Whether keys go into something that takes typing: a text field, not the terminal. */
function isTypingTarget(target) {
  if (!target || !target.matches) return false;
  if (target.closest('.xterm')) return false;
  return target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** Cmd (Ctrl off macOS) plus the key with this `code`, unless the key goes into a text field. */
function isCommandKey(e, code) {
  const mod = sidebarKeyboardMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey || e.code !== code) return false;
  return !isTypingTarget(e.target);
}

const isSessionPickerKey = (e) => isCommandKey(e, 'KeyA');
const isArchiveSessionKey = (e) => isCommandKey(e, 'KeyE');
const isQuickSessionKey = (e) => isCommandKey(e, 'KeyN');

/** A bare N, outside the terminal and text fields. */
function isBareQuickSessionKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.code !== 'KeyN') return false;
  if (e.target?.closest?.('.xterm')) return false;
  return !isTypingTarget(e.target);
}

async function quickSessionPath() {
  const global = await window.api.getSetting('global').catch(() => null);
  return typeof global?.quickSessionPath === 'string' ? global.quickSessionPath.trim() : '';
}

async function launchQuickSession() {
  const folder = await quickSessionPath();
  if (!folder) { openSettingsViewer('global'); return; }
  if (!folder.startsWith('/')) { alert(`The quick session folder must be a full path, not "${folder}".`); openSettingsViewer('global'); return; }
  const project = { folder: encodeProjectPath(folder), projectPath: folder, sessions: [] };
  launchWithDefaultCli(project, await resolveDefaultSessionOptions(project));
}

/** Archive the session on screen, as its row's archive button does. */
function archiveActiveSession() {
  const session = activeSessionId && sessionMap.get(activeSessionId);
  if (session && !session.archived) toggleArchiveSession(session);
}

/**
 * The shortcuts for a keydown, from the terminal or the page. True when one
 * was handled, so the caller stops the key there.
 */
function handleSessionShortcut(e) {
  if (isSidebarFocusKey(e)) { e.preventDefault(); focusSidebar(); return true; }
  if (isSessionPickerKey(e)) { e.preventDefault(); showProjectPickerDialog(); return true; }
  if (isArchiveSessionKey(e)) { e.preventDefault(); archiveActiveSession(); return true; }
  if (isQuickSessionKey(e) || isBareQuickSessionKey(e)) { e.preventDefault(); launchQuickSession(); return true; }
  return false;
}

// --- The session list from the keyboard ---
// Cmd+L moves focus from the terminal into the list, with a cursor on the open
// session's row. Arrows or J and K move it, Enter does what a click does, R or
// F2 renames, E archives (on a group header: the group), A opens the
// new-session picker and Escape goes back to the terminal. The cursor is a
// class on the element, which the morph carries across a redraw
// (preserveSidebarDomState). Ported from Joris Blaak's fork (368a2cc, 98ec26a).

const SIDEBAR_CURSOR_CLASS = 'kbd-cursor';
// Everything the cursor can land on; each one acts on a click.
const SIDEBAR_NAVIGABLE = '.session-item, .project-header, .slug-group-header, .slug-group-more, .sessions-more-toggle';

const isSidebarFocusKey = (e) => {
  const mod = sidebarKeyboardMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.code === 'KeyL';
};

/** Whether the list holds focus: a redraw must not hand it back to the terminal. */
function isSidebarFocused() {
  return document.activeElement === sidebarContent;
}

function sidebarNavigableItems() {
  return [...sidebarContent.querySelectorAll(SIDEBAR_NAVIGABLE)].filter(el => el.offsetParent !== null);
}

const sidebarCursor = () => sidebarContent.querySelector('.' + SIDEBAR_CURSOR_CLASS);

function clearSidebarCursor() {
  sidebarContent.querySelectorAll('.' + SIDEBAR_CURSOR_CLASS).forEach(el => el.classList.remove(SIDEBAR_CURSOR_CLASS));
}

function moveSidebarCursor(el) {
  clearSidebarCursor();
  el.classList.add(SIDEBAR_CURSOR_CLASS);
  el.scrollIntoView({ block: 'nearest' });
}

function focusSidebar() {
  if (activeTab !== 'sessions' || document.getElementById('sidebar')?.classList.contains('collapsed')) return;
  const start = sidebarCursor() || sidebarContent.querySelector('.session-item.active') || sidebarNavigableItems()[0];
  if (!start) return;
  sidebarContent.focus({ preventScroll: true });
  moveSidebarCursor(start);
}

function stepSidebarCursor(direction) {
  const items = sidebarNavigableItems();
  if (!items.length) return;
  const at = items.indexOf(sidebarCursor());
  moveSidebarCursor(at === -1 ? items[0] : items[Math.min(items.length - 1, Math.max(0, at + direction))]);
}

function renameAtSidebarCursor() {
  const item = sidebarCursor();
  if (!item?.classList.contains('session-item')) return;
  const session = sessionMap.get(item.dataset.sessionId);
  const summary = item.querySelector('.session-summary');
  if (!session || !summary) return;
  startRename(summary, session);
  // Enter or Escape ends the rename; the list keeps the keyboard after it.
  item.querySelector('.session-rename-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    setTimeout(() => {
      sidebarContent.focus({ preventScroll: true });
      const again = sidebarContent.querySelector(`[data-session-id="${CSS.escape(item.dataset.sessionId)}"]`);
      if (again) moveSidebarCursor(again);
    });
  });
}

/** Press the archive button under the cursor, then move on to the next row. */
function archiveAtSidebarCursor() {
  const cursor = sidebarCursor();
  const button = cursor?.querySelector('.session-archive-btn, .slug-group-archive-btn, .project-archive-btn');
  if (!button) return;
  const before = sidebarNavigableItems();
  const at = before.indexOf(cursor);
  button.click();
  const next = before[at + 1] || before[at - 1];
  if (next?.isConnected) moveSidebarCursor(next);
}

function sidebarBackToTerminal() {
  clearSidebarCursor();
  const open = activeSessionId && openSessions.get(activeSessionId);
  if (open) open.terminal.focus();
  else sidebarContent.blur();
}

function onSidebarKeyDown(e) {
  // Keys typed into a rename input are the input's own.
  if (e.target !== sidebarContent) return;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const act = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') act(() => stepSidebarCursor(e.key === 'ArrowDown' ? 1 : -1));
  else if (plain && (e.key === 'j' || e.key === 'k')) act(() => stepSidebarCursor(e.key === 'j' ? 1 : -1));
  else if (e.key === 'Enter') act(() => sidebarCursor()?.click());
  else if (plain && (e.key === 'r' || e.key === 'F2')) act(renameAtSidebarCursor);
  else if (plain && e.key === 'e') act(archiveAtSidebarCursor);
  else if (plain && e.key === 'a') act(() => showProjectPickerDialog());
  else if (e.key === 'Escape') act(sidebarBackToTerminal);
}

function installSidebarKeyboard() {
  // Focusable from script only: Tab should not stop on the whole list.
  sidebarContent.tabIndex = -1;
  sidebarContent.addEventListener('keydown', onSidebarKeyDown);
  sidebarContent.addEventListener('focusout', (e) => {
    // A rename input inside the list keeps the cursor; anywhere else ends it.
    if (!sidebarContent.contains(e.relatedTarget)) clearSidebarCursor();
  });
}
