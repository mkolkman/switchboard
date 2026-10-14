// --- Keyboard: shortcuts that start and archive sessions ---
// Cmd+A opens the new-session picker, Cmd+E archives the open session and
// Cmd+N starts a quick session (a bare N too, outside the terminal and text
// fields). In a text field Cmd+A and Cmd+E stay its own (Select All). A quick
// session is Claude in one fixed folder, the global quickSessionPath setting;
// until that is set the lightning button is hidden and the keys open Settings.
// Ported from Joris Blaak's fork (ec9bf71, 98ec26a).
// Depends on: dialogs.js (showProjectPickerDialog, resolveDefaultSessionOptions),
// app.js (launchWithDefaultCli, activeSessionId, sessionMap), projects-view.js
// (toggleArchiveSession), utils.js (encodeProjectPath).

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

/** Show the lightning button only while there is a folder for it. */
async function syncQuickSessionButton() {
  const btn = document.getElementById('quick-session-btn');
  if (!btn) return;
  const folder = await quickSessionPath();
  btn.hidden = !folder;
  btn.title = folder ? `Quick session in ${folder} (${sidebarKeyboardMac ? '⌘N' : 'Ctrl+N'})` : '';
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
  if (isSessionPickerKey(e)) { e.preventDefault(); showProjectPickerDialog(); return true; }
  if (isArchiveSessionKey(e)) { e.preventDefault(); archiveActiveSession(); return true; }
  if (isQuickSessionKey(e) || isBareQuickSessionKey(e)) { e.preventDefault(); launchQuickSession(); return true; }
  return false;
}
