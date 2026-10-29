// --- Who asks for access ---
// macOS and 1Password name Switchboard in every dialog a session's process
// brings up; access-watch.js (main) traces each one to its session. Here:
// the rows for the panel under the dialog (access-panel.js), a lock on the
// session in the sidebar and rail, and a line in the session's header with
// what it asked.
// Depends on: escapeHtml (utils.js), currentSession (project-github-view.js),
// sessionTitle (projects-view.js), activeSessionId (app.js).

const accessPending = new Map(); // id → request a dialog still waits on
const accessHistory = []; // every request this app run, oldest first
const accessHeaderOpen = new Set(); // sessions whose header shows every request
// The header keeps the last request this long after it was answered.
const ACCESS_RECENT_MS = 15 * 60 * 1000;
const accessAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

const ACCESS_LOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function accessSessionName(sessionId) {
  if (!sessionId) return 'Switchboard itself';
  const session = currentSession(sessionId);
  return session ? sessionTitle(session) : `Session ${sessionId.slice(0, 8)}`;
}

/** Why the session asks, from its transcript (access-watch.js runningToolReason), or ''. */
function accessWhy(r) {
  return r.reason?.why || '';
}

/** What a request asks, as the banner's line says it. */
function accessAsks(r) {
  return r.kind === 'op' ? 'waits for 1Password' : `asks for ${r.what}`;
}

function accessTime(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

/** Waiting requests, one row per session and kind of access, with how many. */
function accessPanelRows() {
  const rows = new Map();
  for (const r of accessPending.values()) {
    const key = `${r.sessionId || ''}|${r.kind}|${r.what}`;
    const row = rows.get(key);
    if (row) { row.count++; row.ids.push(r.id); row.latest = r; } else rows.set(key, { count: 1, ids: [r.id], latest: r });
  }
  return [...rows.values()];
}

/** The rows for the panel over other apps (access-panel.js), the newest request first. */
function sendAccessPanelRows(rows) {
  const list = rows.slice().sort((a, b) => String(b.latest.at).localeCompare(String(a.latest.at))).map(({ latest: r, count }) => ({
    id: r.id, sessionId: r.sessionId || '', title: accessSessionName(r.sessionId), asks: accessAsks(r), why: accessWhy(r), command: r.command || '', kind: r.kind, count,
  }));
  window.api.setAccessPanelRows(list).catch(() => {});
}

/** The waiting requests to the panel over the dialog (access-panel.js). */
function renderAccessPanel() {
  sendAccessPanelRows(accessPanelRows());
}

/**
 * The lock on a waiting session's row and rail button: a stylesheet of its
 * own, so the sidebar can redraw its rows as often as it likes.
 */
function renderAccessMarks() {
  let style = document.getElementById('access-marks');
  if (!style) {
    style = document.createElement('style');
    style.id = 'access-marks';
    document.head.appendChild(style);
  }
  const ids = [...new Set([...accessPending.values()].map(r => r.sessionId).filter(Boolean))]
    .map(id => id.replace(/[^0-9a-zA-Z-]/g, ''));
  style.textContent = ids.length ? `${ids.map(id => `.session-item[data-session-id="${id}"] .session-summary`).join(',\n')} { padding-left: 17px; position: relative; }
${ids.map(id => `.session-item[data-session-id="${id}"] .session-summary::before`).join(',\n')} { content: ''; position: absolute; left: 0; top: 50%; width: 12px; height: 12px; margin-top: -6px; background: #e0b860; -webkit-mask: var(--access-lock) center / contain no-repeat; animation: access-pulse 1.4s ease-in-out infinite; }
${ids.map(id => `.rail-session[data-session="${id}"]`).join(',\n')} { box-shadow: inset 0 0 0 1.5px rgba(224,184,96,0.85); animation: access-pulse 1.4s ease-in-out infinite; }` : '';
}

/** The active session's header: its latest request, and on a click all of them. */
function renderAccessHeader() {
  const header = document.getElementById('terminal-header');
  if (!header) return;
  let line = document.getElementById('terminal-header-access');
  const id = activeSessionId;
  const mine = id ? accessHistory.filter(r => r.sessionId === id) : [];
  const latest = mine[mine.length - 1];
  const recent = latest && (!latest.answer || Date.now() - new Date(latest.answeredAt || latest.at).getTime() < ACCESS_RECENT_MS);
  if (!latest || (!recent && !accessHeaderOpen.has(id))) { line?.remove(); return; }
  if (!line) {
    line = document.createElement('div');
    line.id = 'terminal-header-access';
    header.appendChild(line);
  }
  const open = accessHeaderOpen.has(id);
  const row = (r) => `<div class="access-h-row${r.answer ? '' : ' access-h-row--waiting'}">
      <span class="access-h-time">${escapeHtml(accessTime(r.at))}</span>
      <span class="access-h-what" title="${accessAttr(accessWhy(r) ? `Why: ${accessWhy(r)}` : '')}">${escapeHtml(r.kind === 'op' ? '1Password' : r.what)}</span>
      <span class="access-h-cmd" title="${accessAttr(r.command || '')}">${escapeHtml(r.command || '')}</span>
      <span class="access-h-answer">${escapeHtml(r.answer ? r.answer : 'waiting')}</span>
    </div>`;
  const earlier = mine.length - 1;
  line.innerHTML = `<span class="access-icon">${ACCESS_LOCK}</span>
    <div class="access-h-list">${(open ? mine.slice().reverse() : [latest]).map(row).join('')}</div>
    ${earlier ? `<button type="button" class="ctx-hide" data-access-more="1">${open ? 'Less' : `${earlier} earlier`}</button>` : ''}`;
  const more = line.querySelector('[data-access-more]');
  if (more) more.onclick = () => { if (open) accessHeaderOpen.delete(id); else accessHeaderOpen.add(id); renderAccessHeader(); };
}

function renderAccess() {
  renderAccessHeader();
  renderAccessMarks();
  renderAccessPanel();
}

function addAccessRequest(r) {
  if (accessHistory.some(h => h.id === r.id)) return;
  accessHistory.push(r);
  if (!r.answer) accessPending.set(r.id, r);
}

window.api.onAccessRequest((r) => { addAccessRequest(r); renderAccess(); });
window.api.onAccessReason(({ id, reason }) => {
  const r = accessHistory.find(h => h.id === id);
  if (!r) return;
  r.reason = reason;
  renderAccess();
});
window.api.onAccessAnswer(({ id, answer, answeredAt }) => {
  const r = accessHistory.find(h => h.id === id);
  if (r) Object.assign(r, { answer, answeredAt });
  accessPending.delete(id);
  renderAccess();
});
// What was asked before this window (re)loaded.
window.api.getAccessSnapshot().then((snap) => {
  for (const r of snap?.history || []) addAccessRequest(r);
  for (const r of snap?.pending || []) addAccessRequest(r);
  renderAccess();
}).catch(() => {});
// The header's "recent" runs out by itself.
setInterval(renderAccessHeader, 60 * 1000);
