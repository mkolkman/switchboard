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

// --- Fuzzy matching (the new-session picker). Ported from Joris Blaak's fork (7064b6c). ---

/**
 * True when position `i` in `text` starts a new word: the first character, one
 * after a separator, or a camelCase hump.
 */
function isFuzzyBoundary(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (/[\s/\\_.@:-]/.test(prev)) return true;
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
}

// One left-to-right pass, taking each query character at the earliest position
// at or after `start` that still keeps the match in order.
function fuzzyScanFrom(q, lower, text, start) {
  const positions = [];
  let score = 0;
  let prev = -2;
  let from = start;
  for (let qi = 0; qi < q.length; qi++) {
    const at = qi === 0 ? start : lower.indexOf(q[qi], from);
    if (at === -1) return null;
    score += 10;
    // Contiguity outweighs a word boundary: in a separator-heavy string every
    // character sits on a boundary, and "b-o-a-r-d" should not outrank the
    // literal "board".
    if (at === prev + 1) score += 25;              // contiguous run
    // Where the match starts says more about intent than a boundary in the
    // middle of it: "sb" should anchor on switchboard, not on the s of joris.
    if (isFuzzyBoundary(text, at)) score += qi === 0 ? 25 : 15;
    if (qi === 0) score -= Math.min(at, 20);       // reward matching early
    positions.push(at);
    prev = at;
    from = at + 1;
  }
  return { score, positions };
}

/**
 * Fuzzy-match `query` against `text` as a case-insensitive subsequence.
 *
 * Returns null when a query character can't be found in order, otherwise the
 * score (higher is better) and the matched positions, so callers can highlight
 * them. Scoring favours contiguous runs, word boundaries, and matches that
 * start early — which is what ranks "swb" onto switchboard ahead of
 * some/web/lib. An empty query matches everything with score 0.
 */
function fuzzyMatch(query, text) {
  if (!query) return { score: 0, positions: [] };
  if (!text) return null;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  // A single greedy pass can settle for a worse run than one further along
  // ("ab" against "a-ab"), so restart from every occurrence of the first
  // character and keep the best-scoring match.
  let best = null;
  for (let start = lower.indexOf(q[0]); start !== -1; start = lower.indexOf(q[0], start + 1)) {
    const match = fuzzyScanFrom(q, lower, text, start);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}
