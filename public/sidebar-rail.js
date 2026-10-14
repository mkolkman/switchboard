// --- The collapsed sidebar: a rail with the current mode and its short list ---
// Collapsed, the sidebar keeps a 42px rail: the expand button, the icon of the
// mode (tab) it is in, which opens a menu to switch mode, and below it a short
// form of that mode's list. Projects show their marks, Sessions their initials
// with a status dot, GitHub its PR numbers, Todo its section icons and Help
// Scout its ticket numbers; each one does what its full row does on a click.
// The lists come from what the expanded sidebar holds, in its order and with
// its filters, so the two never disagree.
// Depends on: app.js (activeTab, sidebarContent, openSession), projects-view.js
// (findTreeProject, markHtml, selectProject, sessionTitle, showContextMenu),
// project-github-view.js (prSessionState, githubItemKey), github-view.js
// (githubViewItems, openGithubViewItem), todo-view.js (todoViewSections,
// todoViewer), helpscout-view.js (helpscoutViewState, openHelpscoutConversation).

const sidebarRail = document.getElementById('sidebar-rail');
const SIDEBAR_RAIL_LIMIT = 40;
const SIDEBAR_RAIL_TABS = ['projects', 'sessions', 'github', 'todo', 'helpscout', 'plans', 'memory', 'stats'];

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

function railSessionItems() {
  // The rows the Sessions list shows, in its order; not the ones folded under "older".
  const rows = [...sidebarContent.querySelectorAll('.session-item[data-session-id]')]
    .filter(row => !row.closest('.sessions-older, .slug-group-older'));
  return rows.slice(0, SIDEBAR_RAIL_LIMIT).map(row => {
    const id = row.dataset.sessionId;
    const session = sessionMap.get(id);
    if (!session) return '';
    const title = sessionTitle(session);
    const [kind, state] = prSessionState(id);
    return `<button type="button" class="rail-item rail-session${id === activeSessionId ? ' active' : ''}" data-session="${railAttr(id)}" title="${railAttr(`${title}\n${state}`)}">
        <span class="rail-initials">${escapeHtml(railInitials(title))}</span><span class="rail-dot rail-dot--${kind}"></span></button>`;
  }).join('');
}

function railGithubItems() {
  const selected = githubTabState(GITHUB_VIEW_PROJECT.id).selection?.itemKey || null;
  return githubViewItems().slice(0, SIDEBAR_RAIL_LIMIT).map(item => {
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

const RAIL_LISTS = {
  projects: railProjectItems,
  sessions: railSessionItems,
  github: railGithubItems,
  todo: railTodoItems,
  helpscout: railHelpscoutItems,
};

/** Draw the rail; a no-op while the sidebar is open. Called by every list that changes. */
function renderSidebarRail() {
  if (!sidebarRail || !isSidebarCollapsed()) return;
  const tab = railTabButton(activeTab);
  const list = RAIL_LISTS[activeTab];
  const scroll = sidebarRail.querySelector('.rail-list')?.scrollTop || 0;
  sidebarRail.innerHTML = `
    <button type="button" class="rail-mode" title="${railAttr(`${tab?.title || activeTab}\nClick to switch`)}">${tab ? railIcon(tab.innerHTML, 18) : ''}</button>
    <div class="rail-list">${list ? list() : ''}</div>`;
  sidebarRail.querySelector('.rail-list').scrollTop = scroll;
  sidebarRail.querySelector('.rail-mode').onclick = (e) => {
    showContextMenu(SIDEBAR_RAIL_TABS.map(railTabButton).filter(Boolean).map(btn => ({
      label: btn.title.split(':')[0],
      icon: railIcon(btn.innerHTML, 14),
      muted: btn.dataset.tab === activeTab,
      onClick: () => btn.click(),
    })), { anchor: e.currentTarget });
  };
  sidebarRail.querySelectorAll('[data-project]').forEach(b => { b.onclick = () => selectProject(b.dataset.project); });
  sidebarRail.querySelectorAll('[data-session]').forEach(b => {
    b.onclick = () => { const s = sessionMap.get(b.dataset.session); if (s) openSession(s); };
  });
  sidebarRail.querySelectorAll('[data-pr]').forEach(b => { b.onclick = () => openGithubViewItem(b.dataset.pr, null); });
  sidebarRail.querySelectorAll('[data-section]').forEach(b => {
    b.onclick = () => todoViewer.querySelector(`.tdv-section[data-section="${CSS.escape(b.dataset.section)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  sidebarRail.querySelectorAll('[data-conv]').forEach(b => { b.onclick = () => openHelpscoutConversation(Number(b.dataset.conv)); });
}

// Session states change without a redraw of the list; keep the dots honest.
setInterval(() => { if (activeTab === 'sessions') renderSidebarRail(); }, 3000);
