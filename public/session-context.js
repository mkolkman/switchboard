// --- What a session works on, and the way back to where it was opened ---
// A session's context is everything it belongs to or works on: its project and
// track, plan items and the issues and PRs among them (plan links), a PR or
// issue it was started from elsewhere, a Help Scout ticket, a Grafana alert or
// log search (session_links), and the PR of the branch it works on (found from
// its transcript). The terminal header shows it as a breadcrumb anyone can
// click through, the sidebar and rail as a short label.
// A session also has an origin, the place it was opened from in this run of
// the app: the header's back button returns there, and closing the session
// returns there too while you are still in that tab.
// In a tab with a detail page (GitHub, a project's Plan, Help Scout, Grafana)
// a session opens beside the page; the header's Hide button puts the page back
// on its own (registerSessionSplit).
// Depends on: app.js (activeTab, activeSessionId, sessionMap, openSessions),
// projects-view.js (projectForSession, findTreeProject, selectProject, PICONS,
// planState, loadProjectPlan, mainEl), project-github-view.js
// (githubLinkForSession, githubTabState, githubRepoName), github-view.js
// (openGithubViewPullRequest), helpscout-view.js (helpscoutLinkFor,
// openHelpscoutTicket), grafana-view.js (openGrafanaAlert, selectGrafana).

const sessionLinkRows = new Map(); // sessionId → [{ kind, ref, label }]
const sessionBranchPrs = new Map(); // sessionId → { pr, at } from its branch
const sessionOrigins = new Map(); // sessionId → { tab, label, restore }
const SESSION_BRANCH_PR_MS = 10 * 60 * 1000;

async function loadSessionLinks() {
  const rows = await window.api.getSessionLinks().catch(() => []);
  sessionLinkRows.clear();
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = sessionLinkRows.get(row.sessionId) || [];
    list.push({ kind: row.kind, ref: row.ref, label: row.label });
    sessionLinkRows.set(row.sessionId, list);
  }
}

/** Remember that a session works on something: kind pr, issue, ticket, alert or logs. */
function linkSession(sessionId, kind, ref, label = null) {
  if (!sessionId || !kind || !ref) return;
  const list = sessionLinkRows.get(sessionId) || [];
  if (!list.some(l => l.kind === kind && l.ref === ref)) list.push({ kind, ref, label });
  sessionLinkRows.set(sessionId, list);
  window.api.addSessionLink({ sessionId, kind, ref: String(ref), label }).catch(() => {});
  refreshSessionContextViews(sessionId);
}

/** The sessions linked to something (kind, ref), newest first. */
function sessionsLinkedTo(kind, ref) {
  const want = String(ref).toLowerCase();
  const ids = [];
  for (const [sessionId, links] of sessionLinkRows) if (links.some(l => l.kind === kind && String(l.ref).toLowerCase() === want)) ids.push(sessionId);
  return ids.reverse();
}

/** The PR of the branch a session works on, read once in a while; repaints when it arrives. */
function sessionBranchPr(sessionId) {
  const known = sessionBranchPrs.get(sessionId);
  if (known && Date.now() - known.at < SESSION_BRANCH_PR_MS) return known.pr;
  sessionBranchPrs.set(sessionId, { pr: known?.pr || null, at: Date.now() });
  window.api.getSessionBranchPr(sessionId).then(result => {
    const pr = result && !result.error ? result.pr : null;
    const before = known?.pr?.key || null;
    sessionBranchPrs.set(sessionId, { pr, at: Date.now() });
    if ((pr?.key || null) !== before) refreshSessionContextViews(sessionId);
  }).catch(() => {});
  return known?.pr || null;
}

// --- Going to a context ---

/** The Projects tab on a project, on one of its tabs (overview, plan, …). */
function openProjectAt(project, tab = 'overview') {
  const projectsTab = document.querySelector('.sidebar-tab[data-tab="projects"]');
  if (projectsTab && activeTab !== 'projects') projectsTab.click();
  selectProject(project.id, { tab });
}

/** A PR or issue: in the project whose plan has it, else in the GitHub tab (a PR) or the browser. */
function openGithubContext(key, { project = null, item = null, url = '' } = {}) {
  if (project && item) {
    githubTabState(project.id).selection = { itemKey: item.itemKey, view: item.view };
    githubTabState(project.id).review = null;
    openProjectAt(project, 'plan');
    return;
  }
  if (typeof openGithubViewPullRequest === 'function' && /#\d+$/.test(key)) openGithubViewPullRequest(key, { url });
  else if (url) window.api.openExternal(url);
}

/**
 * Everything a session works on, in breadcrumb order:
 * [{ kind, key, label, title, open, detected? }], project first.
 */
function sessionContexts(sessionId) {
  const session = sessionMap.get(sessionId) || openSessions.get(sessionId)?.session || null;
  const out = [];
  const seen = new Set();
  const push = (ctx) => { if (!seen.has(ctx.key)) { seen.add(ctx.key); out.push(ctx); } };
  const owner = session && typeof projectForSession === 'function' ? projectForSession(session) : null;
  const project = owner?.project || null;
  if (project) {
    push({ kind: 'project', key: `project:${project.id}`, label: project.name, title: `Project ${project.name}`, open: () => openProjectAt(project, 'overview') });
    const track = session.trackId ? (project.tracks || []).find(t => t.id === session.trackId) : null;
    if (track) push({ kind: 'track', key: `track:${track.id}`, label: track.name, title: `Track ${track.name}`, open: () => openProjectAt(project, 'overview') });
    // The plan's links: the issue or PR an item is (githubLinkForSession), else the item itself.
    const state = planState(project);
    if (!state.data && !state.loading) {
      state.loading = true;
      loadProjectPlan(project).finally(() => { state.loading = false; refreshSessionContextViews(sessionId); });
    }
    const link = typeof githubLinkForSession === 'function' ? githubLinkForSession(project, sessionId) : null;
    if (link) {
      const isPr = link.view && link.view !== 'issue';
      const key = isPr ? link.view : link.itemKey;
      push({ kind: isPr ? 'pr' : 'issue', key: key.toLowerCase(), label: link.label, title: `${key} in ${project.name}'s plan`, open: () => openGithubContext(key, { project, item: link }) });
    }
    for (const l of state.data?.links || []) {
      if (l.sessionId !== sessionId || /#\d+$/.test(l.itemText)) continue;
      push({ kind: 'plan', key: `plan:${l.file}:${l.itemText}`, label: l.itemText.length > 40 ? `${l.itemText.slice(0, 40)}…` : l.itemText, title: `Plan item: ${l.itemText}`, open: () => openProjectAt(project, 'plan') });
    }
  }
  for (const l of sessionLinkRows.get(sessionId) || []) {
    if (l.kind === 'pr' || l.kind === 'issue') {
      const n = String(l.ref).split('#')[1];
      push({ kind: l.kind, key: String(l.ref).toLowerCase(), label: `${l.kind === 'pr' ? 'PR' : 'Issue'} #${n}`, title: `${l.ref}${l.label ? `: ${l.label}` : ''}`, open: () => openGithubContext(l.ref) });
    } else if (l.kind === 'alert') {
      push({ kind: 'alert', key: `alert:${l.ref}`, label: l.label ? `Alert: ${l.label}` : 'Alert', title: `Grafana alert ${l.label || l.ref}`, open: () => openGrafanaAlert(l.ref) });
    } else if (l.kind === 'logs') {
      push({ kind: 'logs', key: `logs:${l.ref}`, label: l.label || 'Logs', title: 'Grafana log search', open: () => openGrafanaLogs(l.ref) });
    }
  }
  const ticket = typeof helpscoutLinkFor === 'function' ? helpscoutLinkFor(sessionId) : null;
  if (ticket) push({ kind: 'ticket', key: `ticket:${ticket.conversation}`, label: `Ticket #${ticket.number}`, title: `Help Scout ticket: ${ticket.subject || ''}`, open: () => openHelpscoutTicket(ticket.conversation) });
  // Only for sessions open in this run: reading every listed session's branch would be a flood.
  const branchPr = session && openSessions.has(sessionId) ? sessionBranchPr(sessionId) : null;
  if (branchPr) push({ kind: 'pr', key: branchPr.key.toLowerCase(), label: `PR #${branchPr.number}`, title: `${branchPr.key}: ${branchPr.title}\nThe PR of the branch this session works on`, detected: true, open: () => openGithubContext(branchPr.key, { url: branchPr.url, ...prInProject(branchPr.key) }) });
  return out;
}

/** The project whose plan lists a PR, and that item, so the PR opens there: { project, item } or {}. */
function prInProject(key) {
  const k = key.toLowerCase();
  for (const project of cachedProjectTreeAll?.projects || []) {
    const state = typeof githubTabState === 'function' ? githubTabState(project.id) : null;
    for (const result of state?.results?.values() || []) {
      for (const item of result?.items || []) {
        const pr = (item.pullRequests || []).find(p => `${p.repo}#${p.number}`.toLowerCase() === k);
        if (pr) return { project, item: { itemKey: githubItemKey(item), view: `${pr.repo}#${pr.number}` } };
      }
    }
  }
  return {};
}

function openGrafanaLogs(platform) {
  const tab = document.querySelector('.sidebar-tab[data-tab="grafana"]');
  if (platform) grafanaViewState.platform = platform;
  grafanaViewState.selected = { kind: 'logs', id: null };
  if (tab && activeTab !== 'grafana') tab.click();
  else selectGrafana({ kind: 'logs', id: null });
}

const SESSION_CONTEXT_RANK = ['ticket', 'pr', 'issue', 'alert', 'logs', 'plan'];

/** The one context a session row shows: ticket, PR, issue, alert, log search or plan item; null for none. */
function sessionContextLabel(sessionId) {
  const contexts = sessionContexts(sessionId).filter(c => SESSION_CONTEXT_RANK.includes(c.kind));
  contexts.sort((a, b) => SESSION_CONTEXT_RANK.indexOf(a.kind) - SESSION_CONTEXT_RANK.indexOf(b.kind));
  return contexts[0] || null;
}

// --- Origin: where a session was opened, and back there ---

/** Where you are now, as a place to come back to: { tab, label, restore } or null in the Sessions tab. */
function sessionPlaceHere() {
  const tab = activeTab;
  if (tab === 'github' && typeof githubTabState === 'function') {
    const sel = githubTabState(GITHUB_VIEW_PROJECT.id).selection;
    if (!sel) return null;
    const key = sel.view !== 'issue' ? sel.view : sel.itemKey;
    return {
      tab, label: `PR #${String(key).split('#')[1]}`,
      restore: () => {
        const ghTab = document.querySelector('.sidebar-tab[data-tab="github"]');
        if (ghTab && activeTab !== 'github') ghTab.click();
        openGithubViewItem(sel.itemKey, sel.view);
      },
    };
  }
  if (tab === 'projects') {
    const project = selectedProject();
    if (!project) return null;
    const sel = githubTabState(project.id).selection;
    if (sel) {
      const key = sel.view !== 'issue' ? sel.view : sel.itemKey;
      return { tab, label: `${sel.view !== 'issue' ? 'PR' : 'Issue'} #${String(key).split('#')[1]}`, restore: () => { githubTabState(project.id).selection = { ...sel }; openProjectAt(project, 'plan'); } };
    }
    const navTab = projectNavigation(project).tab || 'overview';
    return { tab, label: project.name, restore: () => openProjectAt(project, navTab) };
  }
  if (tab === 'helpscout' && helpscoutViewState.selectedId) {
    const id = helpscoutViewState.selectedId;
    const number = helpscoutViewState.conversation?.number;
    return { tab, label: number ? `Ticket #${number}` : 'Ticket', restore: () => openHelpscoutTicket(id) };
  }
  if (tab === 'grafana') {
    const sel = { ...grafanaViewState.selected };
    const alert = sel.kind === 'alert' ? grafanaViewState.alerts?.find(a => a.uid === sel.id) : null;
    return { tab, label: alert ? `Alert: ${alert.title}` : sel.kind === 'logs' ? 'Logs' : 'Grafana', restore: () => (sel.kind === 'alert' ? openGrafanaAlert(sel.id) : openGrafanaLogs(grafanaViewState.platform)) };
  }
  return null;
}

/** Called when a session is opened from a place: the back button and closing it lead there. */
function rememberSessionOrigin(sessionId, place = sessionPlaceHere()) {
  if (!sessionId || !place) return;
  sessionOrigins.set(sessionId, place);
  if (sessionId === activeSessionId) renderSessionContextHeader();
}

/** On closing or stopping a session: back to its origin, if you are still in that tab. */
function returnFromSession(sessionId) {
  const origin = sessionOrigins.get(sessionId);
  sessionOrigins.delete(sessionId);
  leaveSessionSplit();
  if (origin) { if (origin.tab === activeTab) origin.restore(); return; }
  // Opened before this run of the app: a ticket's session still leads back to it.
  if (typeof returnToHelpscoutTicket === 'function') returnToHelpscoutTicket(sessionId);
}

// --- The session beside a page ---

const sessionSplits = new Map(); // tab → { viewer, className, hide, applies(sessionId) }

/**
 * A tab whose page a shown session sits beside. `viewer` is its main element,
 * `className` the class on #main that splits it, `hide()` puts the page back
 * alone, `applies(sessionId)` says whether this session should (default all).
 */
function registerSessionSplit(tab, spec) {
  sessionSplits.set(tab, spec);
}

/** From showSession: put the page back beside the session, in a tab that has one. */
function onSessionSplitShown(sessionId) {
  const spec = sessionSplits.get(activeTab);
  if (!spec || gridViewActive || (spec.applies && !spec.applies(sessionId))) return false;
  mainEl.classList.add(spec.className);
  spec.viewer().style.display = 'flex';
  placeholder.style.display = 'none';
  terminalArea.style.display = '';
  if (spec.onShown) spec.onShown(sessionId);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  return true;
}

/** Undo any split: the page alone again. */
function leaveSessionSplit() {
  for (const [tab, spec] of sessionSplits) {
    if (!mainEl.classList.contains(spec.className)) continue;
    mainEl.classList.remove(spec.className);
    if (activeTab === tab) terminalArea.style.display = 'none';
    if (spec.onLeave) spec.onLeave();
  }
}

// The GitHub tab: the PR panel on the left.
registerSessionSplit('github', { viewer: () => githubViewer, className: 'ghv-split', hide: () => leaveSessionSplit() });

// A project: only sessions opened from its PR panel sit beside the Plan tab;
// the others open in the project's working view (strip, panes, terminal).
const projectSplitSessions = new Set();
let projectSplitNext = false; // a PR session being launched from a project's panel
// The session sits under the project's header: its height, kept current while
// split (the page redraws its header, so the observer follows the new one).
let observedProjectHead = null;
const projectHeadObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measureProjectHead()) : null;
function measureProjectHead() {
  const head = projectViewer.querySelector('.ws-header');
  if (!head) return;
  mainEl.style.setProperty('--proj-head-h', `${head.offsetHeight}px`);
  if (projectHeadObserver && head !== observedProjectHead && mainEl.classList.contains('proj-split')) {
    projectHeadObserver.disconnect();
    projectHeadObserver.observe(head);
    observedProjectHead = head;
  }
}
window.addEventListener('resize', () => { if (mainEl.classList.contains('proj-split')) measureProjectHead(); });
registerSessionSplit('projects', {
  viewer: () => projectViewer,
  className: 'proj-split',
  applies: (sessionId) => projectSplitSessions.has(sessionId) || projectSplitNext,
  onShown: () => measureProjectHead(),
  onLeave: () => { projectHeadObserver?.disconnect(); observedProjectHead = null; },
  hide: () => leaveSessionSplit(),
});

function sessionSplitActive() {
  return [...sessionSplits.values()].some(spec => mainEl.classList.contains(spec.className));
}

// --- The terminal header's breadcrumb ---

const SESSION_CONTEXT_ICONS = {
  project: () => PICONS.folder(11), track: () => PICONS.branch(11), plan: () => PICONS.check(11),
  pr: () => '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-3 3 3 3"/></svg>',
  issue: () => '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  ticket: () => '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H8l-4 4z"/></svg>',
  alert: () => '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>',
  logs: () => PICONS.list(11),
};

const terminalHeaderContext = document.getElementById('terminal-header-context');

/** The back button, the breadcrumb and the Hide button for the session on screen. */
function renderSessionContextHeader() {
  if (!terminalHeaderContext) return;
  const id = activeSessionId;
  if (!id) { terminalHeaderContext.innerHTML = ''; terminalHeaderContext.style.display = 'none'; return; }
  const contexts = sessionContexts(id);
  const origin = sessionOrigins.get(id);
  const split = sessionSplitActive();
  // Beside its page the origin is already in view: no back button then.
  // When the breadcrumb already names the origin, the button just says Back.
  const named = origin && contexts.some(c => c.label === origin.label);
  const back = origin && !split ? `<button type="button" class="ctx-back" data-ctx-back="1" title="${escapeHtml(`Back to ${origin.label}, where this session was opened`).replace(/"/g, '&quot;')}">${PICONS.back(11)}<span>${escapeHtml(named ? 'Back' : origin.label)}</span></button>` : '';
  // Project › track › what it works on · and more: a chevron down the hierarchy, a dot between the rest.
  const crumbs = contexts.map((c, i) => {
    const sep = !i ? '' : (['project', 'track'].includes(contexts[i - 1].kind) ? '<span class="ctx-sep">›</span>' : '<span class="ctx-sep">·</span>');
    return `${sep}<button type="button" class="ctx-crumb ctx-crumb--${c.kind}${c.detected ? ' ctx-crumb--detected' : ''}" data-ctx="${i}" title="${escapeHtml(c.title).replace(/"/g, '&quot;')}">${SESSION_CONTEXT_ICONS[c.kind] ? SESSION_CONTEXT_ICONS[c.kind]() : ''}<span>${escapeHtml(c.label)}</span></button>`;
  }).join('');
  // Beside a page: take the session full width in the Sessions tab (its back button returns), or hide it.
  const hide = split ? '<button type="button" class="ctx-hide" data-ctx-full="1" title="Open it full width in the Sessions tab; Back there returns here"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg><span>Open in Sessions</span></button>'
    + '<button type="button" class="ctx-hide" data-ctx-hide="1" title="Show the page alone; the session keeps running">Hide session</button>' : '';
  terminalHeaderContext.innerHTML = `${back}${crumbs}<span class="ws-flex"></span>${hide}`;
  terminalHeaderContext.style.display = back || crumbs || hide ? '' : 'none';
  terminalHeaderContext.querySelectorAll('[data-ctx]').forEach(b => { b.onclick = () => contexts[Number(b.dataset.ctx)]?.open(); });
  const backBtn = terminalHeaderContext.querySelector('[data-ctx-back]');
  if (backBtn) backBtn.onclick = () => origin.restore();
  const fullBtn = terminalHeaderContext.querySelector('[data-ctx-full]');
  if (fullBtn) fullBtn.onclick = () => openSessionInSessionsTab(id);
  const hideBtn = terminalHeaderContext.querySelector('[data-ctx-hide]');
  if (hideBtn) hideBtn.onclick = () => { const spec = sessionSplits.get(activeTab); if (spec?.hide) spec.hide(); else leaveSessionSplit(); };
}

/** A session row's context label (sidebar.js): what it works on, a click goes there. */
function sessionContextChip(el, sessionId) {
  const ctx = sessionContextLabel(sessionId);
  el.innerHTML = ctx ? `${SESSION_CONTEXT_ICONS[ctx.kind] ? SESSION_CONTEXT_ICONS[ctx.kind]() : ''}<span>${escapeHtml(ctx.label)}</span>` : '';
  el.className = `session-ctx${ctx ? ` session-ctx--${ctx.kind}` : ''}`;
  el.title = ctx ? `${ctx.title}\nClick to open` : '';
  el.onclick = ctx ? (e) => { e.stopPropagation(); ctx.open(); } : null;
}

function refreshSidebarContextLabels() {
  document.querySelectorAll('.session-ctx[data-ctx-session]').forEach(el => sessionContextChip(el, el.dataset.ctxSession));
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

/** The session full width in the Sessions tab; where it was beside stays its origin, for Back. */
function openSessionInSessionsTab(sessionId) {
  if (!sessionOrigins.has(sessionId)) rememberSessionOrigin(sessionId);
  leaveSessionSplit();
  const tab = document.querySelector('.sidebar-tab[data-tab="sessions"]');
  if (tab && activeTab !== 'sessions') tab.click();
  if (openSessions.has(sessionId)) showSession(sessionId);
}

/** A session's context changed (a link came in, its branch PR was found): the header and its rows. */
function refreshSessionContextViews(sessionId) {
  if (sessionId === activeSessionId) renderSessionContextHeader();
  refreshSidebarContextLabels();
}

loadSessionLinks().then(() => refreshSessionContextViews(activeSessionId));
