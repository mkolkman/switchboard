// --- The collapsed sidebar: a rail with the current mode and its short list ---
// Collapsed, the sidebar keeps a 42px rail: the expand button, the icon of the
// mode (tab) it is in, which opens a menu to switch mode, and below it a short
// form of that mode's list. Projects show their marks, Sessions (only the live
// ones) their repo's short name with a status dot, the kind of session and its
// track or branch, GitHub its PR numbers, Todo its section icons, Help Scout
// its ticket numbers and Observability its products and firing or pending
// alerts; each one does what its full row does on a click.
// In Sessions a + under the mode button starts a new session, like the open
// sidebar's.
// The lists come from what the expanded sidebar holds, in its order and with
// its filters, so the two never disagree.
// Depends on: app.js (activeTab, sidebarContent, openSession), projects-view.js
// (findTreeProject, markHtml, projectHue, selectProject, sessionTitle,
// showContextMenu), sidebar.js (isChatFolder), session-groups.js (folderBaseName),
// project-github-view.js (prSessionState, githubItemKey), github-view.js
// (githubViewState, openGithubViewItem), todo-view.js (todoViewSections,
// todoViewer), helpscout-view.js (helpscoutViewState, openHelpscoutConversation),
// grafana-view.js (grafanaViewState, selectGrafana), observability-view.js
// (observabilityState, observabilityStatus, observabilityProductAlerts).

const sidebarRail = document.getElementById('sidebar-rail');
const SIDEBAR_RAIL_LIMIT = 40;
const SIDEBAR_RAIL_TABS = ['todo', 'sessions', 'projects', 'github', 'grafana', 'helpscout', 'plans', 'memory', 'stats'];
// The mode menu follows the order picked in Global settings (app.js sidebarTabOrder).
const railTabOrder = () => (typeof sidebarTabOrder === 'function' ? sidebarTabOrder() : SIDEBAR_RAIL_TABS);

const railTabButton = (name) => document.querySelector(`.sidebar-tab[data-tab="${name}"]`);
const railIcon = (svg, size) => svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
const railAttr = (value) => escapeHtml(String(value)).replace(/"/g, '&quot;');

function isSidebarCollapsed() {
  return document.getElementById('sidebar')?.classList.contains('collapsed');
}

/** Two letters for a title: the first letters of its first two words. */
function railInitials(title) {
  const words = String(title || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function railProjectItems() {
  return [...document.querySelectorAll('#projects-content .proj-row[data-project-id]')].slice(0, SIDEBAR_RAIL_LIMIT).map(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (!project) return '';
    return `<button type="button" class="rail-item${row.classList.contains('selected') ? ' active' : ''}" data-project="${railAttr(project.id)}" title="${railAttr(project.name)}">${markHtml(project, 26)}</button>`;
  }).join('');
}

// Short names for the repositories worked in most; others get their words' initials.
const RAIL_REPO_ABBREVIATIONS = [
  [/^movelab-connect/i, 'MLC'],
  [/^nohrd-account/i, 'NA'],
  [/^nohrd-connect/i, 'NC'],
  [/^waterrower.*connect/i, 'WRC'],
  [/^rp3/i, 'RP3'],
];

/** "MoveLab-Connect-Web" → "MLC", "switchboard" → "SWI", "my-cool_app" → "MCA". */
function railRepoAbbrev(name) {
  const text = String(name || '').trim();
  if (!text) return '?';
  const known = RAIL_REPO_ABBREVIATIONS.find(([re]) => re.test(text));
  if (known) return known[1];
  const words = text.split(/[-_.\s]+/).filter(Boolean);
  return (words.length > 1 ? words.map(w => w[0]).join('') : text).slice(0, 3).toUpperCase();
}

// What kind of session it is, from how it was started.
const RAIL_KIND_ICONS = {
  review: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  fix: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  support: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6M14.8 14.8l3.6 3.6M14.8 9.2l3.6-3.6M5.6 18.4l3.6-3.6"/>',
  plan: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  build: '<path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9"/><path d="m17.6 15 4.4-4.4-6.6-6.6L11 8.4z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
};
const RAIL_KIND_HINTS = { review: 'Review', fix: 'Fixing review or conflicts', support: 'Support', plan: 'Wayfinder', build: 'Building', chat: 'Chat', terminal: 'Terminal' };

function railSessionKind(session) {
  if (session.type === 'terminal') return 'terminal';
  if (typeof helpscoutLinkFor === 'function' && helpscoutLinkFor(session.sessionId)) return 'support';
  const prompt = String(session.firstPrompt || '');
  if (/review-pr\b/.test(prompt)) return 'review';
  if (/resolve-pr-reviews|resolve the conflicts|rebase .* onto/i.test(prompt)) return 'fix';
  if (/customer-support|log-nohrd-faq|log-feature-request|log-machine-incident/.test(prompt)) return 'support';
  if (/wayfinder/.test(prompt)) return 'plan';
  if (isChatFolder(session.projectPath)) return 'chat';
  return 'build';
}

/** The session's track, else the worktree branch its folder is, as a few letters. */
function railSessionPlace(session) {
  const project = session.projectId ? findTreeProject(session.projectId) : null;
  const track = session.trackId ? (project?.tracks || []).find(t => t.id === session.trackId) : null;
  if (track) return track.name;
  const worktree = String(session.projectPath || '').match(/\/(?:\.claude\/)?(?:\.worktrees|worktrees)\/([^/]+)\/?$/);
  return worktree ? worktree[1] : '';
}

function railSessionItems() {
  // Only the live ones (needs you, unread, working, idle), in the Sessions list's order.
  const ids = [...new Set([...sidebarContent.querySelectorAll('.session-item[data-session-id]')].map(row => row.dataset.sessionId))]
    .filter(id => prSessionState(id)[0] !== 'stopped');
  if (!ids.length) return '<div class="rail-empty" title="No session is running">\u2013</div>';
  return ids.slice(0, SIDEBAR_RAIL_LIMIT).map(id => {
    const session = sessionMap.get(id);
    if (!session) return '';
    const repo = repoInfoByPath.get(session.projectPath)?.name || (isChatFolder(session.projectPath) ? 'Chat' : folderBaseName(session.projectPath));
    const hue = projectHue(repo.toLowerCase());
    const kind = railSessionKind(session);
    // What it works on beats its track or branch: "#2283" for a PR, issue or ticket.
    const ctx = typeof sessionContextLabel === 'function' ? sessionContextLabel(id) : null;
    const ctxShort = ctx && /#\d+/.test(ctx.label) ? `#${ctx.label.split('#')[1]}` : '';
    const place = ctxShort || railSessionPlace(session);
    const [state, stateText] = prSessionState(id);
    const tip = `${sessionTitle(session)}\n${repo}${ctx ? ` \u00b7 ${ctx.label}` : place ? ` \u00b7 ${place}` : ''}\n${RAIL_KIND_HINTS[kind]}, ${stateText}`;
    return `<button type="button" class="rail-item rail-session${id === activeSessionId ? ' active' : ''}" data-session="${railAttr(id)}" title="${railAttr(tip)}">
        <span class="rail-repo" style="background:hsla(${hue},70%,60%,0.18);color:hsl(${hue},80%,72%);">${escapeHtml(railRepoAbbrev(repo))}<span class="rail-dot rail-dot--${state}"></span></span>
        <span class="rail-context"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${RAIL_KIND_ICONS[kind]}</svg>${place ? `<span class="rail-place">${escapeHtml(place.slice(0, ctxShort ? 6 : 4))}</span>` : ''}</span></button>`;
  }).join('');
}

function railGithubItems() {
  const selected = githubTabState(GITHUB_VIEW_PROJECT.id).selection?.itemKey || null;
  // The open ones: what is waiting, not what is done.
  return [...(githubViewState.review || []), ...(githubViewState.mine || [])].slice(0, SIDEBAR_RAIL_LIMIT).map(item => {
    const key = githubItemKey(item);
    return `<button type="button" class="rail-item rail-num${key === selected ? ' active' : ''}" data-pr="${railAttr(key)}" title="${railAttr(`${item.repo}#${item.number}: ${item.title}`)}">#${item.number}</button>`;
  }).join('');
}

function railTodoItems() {
  return todoViewSections().map(sec => {
    // The heading's own emoji is its icon; a heading without one gets its first letter.
    const icon = (sec.title.match(/^\s*(\p{Extended_Pictographic}️?)/u) || [])[1] || railInitials(sec.title).slice(0, 1);
    const count = sec.kind === 'archive' ? sec.archived : sec.items.filter(i => i.checked === false).length;
    return `<button type="button" class="rail-item rail-todo" data-section="${railAttr(sec.id)}" title="${railAttr(`${sec.title}: ${count ?? 0}`)}">
        <span class="rail-emoji">${escapeHtml(icon)}</span>${count ? `<span class="rail-count">${count}</span>` : ''}</button>`;
  }).join('');
}

function railHelpscoutItems() {
  const s = helpscoutViewState;
  const open = (s.inbox?.conversations || []).filter(c => ['unassigned', 'mine', 'assigned'].includes(c.group) && (!s.mailbox || c.mailboxId === s.mailbox));
  return open.slice(0, SIDEBAR_RAIL_LIMIT).map(c => `<button type="button" class="rail-item rail-num rail-num--${c.group}${c.id === s.selectedId ? ' active' : ''}" data-conv="${c.id}" title="${railAttr(`#${c.number} ${c.subject}\n${c.customer.name || c.customer.email}${c.assignee ? `, ${c.assignee.name}` : ''}`)}">#${c.number}</button>`).join('');
}

/** The products by their short name, each with its dot; then firing and pending alerts as dots. */
function railGrafanaItems() {
  const s = grafanaViewState;
  const active = (s.alerts || []).filter(a => a.state === 'firing' || a.state === 'pending');
  const products = observabilityState.overview?.products || [];
  return products.map(p => `<button type="button" class="rail-item rail-num rail-obs${s.selected.kind === 'product' && s.selected.id === p.id ? ' active' : ''}" data-gfv-product="${railAttr(p.id)}" title="${railAttr(p.label)}"><span class="gfv-dot gfv-dot--${railAttr(observabilityStatus(observabilityProductAlerts(p)))}"></span>${escapeHtml(p.short || p.label)}</button>`).join('')
    + active.slice(0, SIDEBAR_RAIL_LIMIT).map(a => `<button type="button" class="rail-item${s.selected.kind === 'alert' && s.selected.id === a.uid ? ' active' : ''}" data-gfv-alert="${railAttr(a.uid)}" title="${railAttr(`${a.state}: ${a.title}`)}"><span class="gfv-dot gfv-dot--${railAttr(a.state)}"></span></button>`).join('');
}

const RAIL_LISTS = {
  projects: railProjectItems,
  sessions: railSessionItems,
  github: railGithubItems,
  todo: railTodoItems,
  helpscout: railHelpscoutItems,
  grafana: railGrafanaItems,
};

/** Draw the rail; a no-op while the sidebar is open. Called by every list that changes. */
function renderSidebarRail() {
  if (!sidebarRail || !isSidebarCollapsed()) return;
  const tab = railTabButton(activeTab);
  const list = RAIL_LISTS[activeTab];
  const scroll = sidebarRail.querySelector('.rail-list')?.scrollTop || 0;
  sidebarRail.innerHTML = `
    <button type="button" class="rail-mode" title="${railAttr(`${tab?.title || activeTab}\nClick to switch`)}">${tab ? railIcon(tab.innerHTML, 18) : ''}</button>
    ${activeTab === 'sessions' ? `<button type="button" class="rail-item rail-new" title="${railAttr(document.getElementById('new-session-btn')?.title || 'New session')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>` : ''}
    <div class="rail-list">${list ? list() : ''}</div>`;
  sidebarRail.querySelector('.rail-list').scrollTop = scroll;
  sidebarRail.querySelector('.rail-mode').onclick = (e) => {
    showContextMenu(railTabOrder().map(railTabButton).filter(Boolean).map(btn => ({
      label: btn.title.split(':')[0],
      icon: railIcon(btn.innerHTML, 14),
      muted: btn.dataset.tab === activeTab,
      onClick: () => btn.click(),
    })), { anchor: e.currentTarget });
  };
  // The open sidebar's + : a chat, or a session in a repository.
  const newBtn = sidebarRail.querySelector('.rail-new');
  if (newBtn) newBtn.onclick = () => showProjectPickerDialog();
  sidebarRail.querySelectorAll('[data-project]').forEach(b => { b.onclick = () => selectProject(b.dataset.project); });
  sidebarRail.querySelectorAll('[data-session]').forEach(b => {
    b.onclick = () => { const s = sessionMap.get(b.dataset.session); if (s) openSession(s); };
  });
  sidebarRail.querySelectorAll('[data-pr]').forEach(b => { b.onclick = () => openGithubViewItem(b.dataset.pr, null); });
  sidebarRail.querySelectorAll('[data-section]').forEach(b => {
    b.onclick = () => todoViewer.querySelector(`.tdv-section[data-section="${CSS.escape(b.dataset.section)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  sidebarRail.querySelectorAll('[data-gfv-alert]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'alert', id: b.dataset.gfvAlert }); });
  sidebarRail.querySelectorAll('[data-gfv-product]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'product', id: b.dataset.gfvProduct }); });
  sidebarRail.querySelectorAll('[data-conv]').forEach(b => { b.onclick = () => openHelpscoutConversation(Number(b.dataset.conv)); });
}

// Session states change without a redraw of the list; keep the dots honest.
setInterval(() => { if (activeTab === 'sessions') renderSidebarRail(); }, 3000);
