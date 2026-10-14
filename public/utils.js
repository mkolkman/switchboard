// --- Utility functions (shared across renderer modules) ---

/**
 * Shorten a project path for display: its last two segments.
 *
 * Splits on both separators. projectPath comes from a session's `cwd`, which on
 * Windows is backslash-separated — splitting on '/' alone finds no separator, so
 * every "short" label rendered the entire path.
 */
function shortProjectPath(projectPath) {
  if (!projectPath) return '';
  return projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

// Session dialogs, schedules and global settings share the same CLI choices.
const { PERMISSION_MODES, CODEX_SANDBOX_MODES, CODEX_APPROVAL_POLICIES } = SessionConfig;

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

// A pending row is one the renderer makes before a session has written its
// transcript, so there is something on screen while the CLI starts. It keeps
// that place only while a real session might still turn up: once its process
// is gone and no transcript came, nothing is coming. Without this a session
// that died before its first turn (a refused --session-id, a failing
// pre-launch command) stayed in the list for good. Ported from Joris Blaak's
// fork (d46b1d5).
const PENDING_GRACE_MS = 60000;

function isPendingAbandoned(pending, { running, onScreen, now = Date.now() } = {}) {
  // Plain terminals are torn down when they exit; this is for CLI sessions.
  if (pending.session?.type === 'terminal') return false;
  // Still running, or on screen with its exit banner: leave it be.
  if (running || onScreen) return false;
  if (pending.exitedAt) return now - pending.exitedAt > PENDING_GRACE_MS;
  // No exit was seen, yet nothing runs under that id (a reload mid-launch, a
  // launch that failed): age from creation, so a slow start keeps its grace.
  const created = new Date(pending.session?.created).getTime();
  return Number.isFinite(created) && now - created > PENDING_GRACE_MS;
}
