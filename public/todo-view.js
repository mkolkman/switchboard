// --- Todo tab: your todo list on a Notion page ---
// The sidebar holds the sections and what happened lately (a new week, todos
// checked off because their GitHub work is done); the main area is the list,
// editable in place. Main reads and writes the page (notion-todo.js) and does
// the week rotation and the GitHub check; this file only draws and asks.
// A GitHub link in a todo opens the project whose plan has that issue or PR,
// else the PR in the GitHub tab, else the issue on github.com.
// Depends on: project-github-view.js (githubItemKey, primaryPullRequest,
// openGithubLink), github-view.js (openGithubViewPullRequest), projects-view.js
// (PICONS, showContextMenu, selectProject, findTreeProject), utils.js
// (escapeHtml, formatDate).

const todoViewContent = document.getElementById('todo-content');
const todoViewer = document.getElementById('todo-viewer');
const TODO_VIEW_REFRESH_MS = 2 * 60 * 1000;
const TODO_VIEW_ACTIVE = ['this', 'next', 'later', 'ideas'];
const TODO_VIEW_GITHUB = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i;

const todoViewState = {
  page: null, error: null, loading: false, saving: 0, timer: null,
  notices: [], editing: null, adding: null,
  // "owner/repo#n" (lower case) → { projectId, link } for issues and PRs in a project's plan.
  planIndex: new Map(),
};

const todoAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

async function loadTodoView({ quiet = false, rotate = true } = {}) {
  if (todoViewState.loading) return;
  todoViewState.loading = true;
  if (!quiet) renderTodoViewList();
  const result = await window.api.loadNotionTodo({ rotate }).catch(err => ({ error: err?.message || String(err) }));
  todoViewState.loading = false;
  todoViewTake(result);
  todoViewBuildPlanIndex();
}

/** A fresh read of the page from main: after a load, an edit, or a background check. */
function todoViewTake(result) {
  if (result?.error) todoViewState.error = result.error;
  else {
    todoViewState.error = null;
    todoViewState.page = result;
    if (result.rotated) {
      const r = result.rotated;
      todoViewState.notices.unshift(`New week: ${r.archived} archived under ${r.label}, ${r.rolledOver} rolled over, ${r.pulledIn} pulled in from next week.`);
    }
    if (result.weekUnreadable) todoViewState.notices.unshift('The This week heading has no week range Switchboard can read, so the week was not rotated.');
    for (const text of result.checkedOff || []) todoViewState.notices.unshift(`Checked off, its GitHub work is done: ${text}`);
    todoViewState.notices = todoViewState.notices.slice(0, 6);
  }
  renderTodoViewList();
  renderTodoViewMain();
}

/** Called by the settings panel after the token or page changed. */
function todoConfigChanged() {
  todoViewState.page = null;
  todoViewState.notices = [];
  if (activeTab === 'todo') loadTodoView();
}

/** Which todo links lead into a plan: every project's tracking issue, its issues and their PRs. */
async function todoViewBuildPlanIndex() {
  const index = new Map();
  const projects = (cachedProjectTree?.projects || []).filter(p => p.githubRefs?.length);
  await Promise.all(projects.map(async (project) => {
    for (const ref of project.githubRefs) {
      const result = await window.api.getGithubTracker(ref).catch(() => null);
      if (!result || result.error) continue;
      const put = (key, link) => { if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), { projectId: project.id, link }); };
      if (result.kind === 'issue') put(ref, null);
      for (const item of result.items || []) {
        const itemKey = githubItemKey(item);
        put(itemKey, { itemKey, view: primaryPullRequest(item) || 'issue' });
        for (const pr of item.pullRequests || []) put(`${pr.repo}#${pr.number}`, { itemKey, view: `${pr.repo}#${pr.number}` });
      }
    }
  }));
  todoViewState.planIndex = index;
  renderTodoViewMain();
}

function todoViewOpenRef(key, url) {
  const hit = todoViewState.planIndex.get(key.toLowerCase());
  const project = hit && findTreeProject(hit.projectId);
  if (project) {
    const tab = document.querySelector('.sidebar-tab[data-tab="projects"]');
    if (tab && activeTab !== 'projects') tab.click();
    selectProject(project.id, { tab: 'plan' });
    if (hit.link) {
      openGithubLink(project, hit.link);
      todoViewReveal(hit.link.itemKey);
    }
    return;
  }
  if (/\/pull\//.test(url)) {
    const info = todoViewState.page?.states?.[key.toLowerCase()];
    openGithubViewPullRequest(key, { url, title: info?.title || '' });
  } else {
    window.api.openExternal(url);
  }
}

/** Scroll the plan to the row once it is drawn; the plan may still be loading. */
function todoViewReveal(itemKey, tries = 20) {
  // A row in the list, or a card in the graph.
  const key = CSS.escape(itemKey);
  const row = projectViewer.querySelector(`.gh-item[data-item="${key}"], .gh-gcard[data-item="${key}"]`);
  if (row) { row.scrollIntoView({ block: 'center', inline: 'center' }); return; }
  if (tries > 0) setTimeout(() => todoViewReveal(itemKey, tries - 1), 250);
}

// --- Editing ---

async function todoViewEdit(edit) {
  todoViewState.saving++;
  renderTodoViewList();
  const result = await window.api.editNotionTodo(edit).catch(err => ({ error: err?.message || String(err) }));
  todoViewState.saving--;
  if (result?.error) {
    todoViewState.notices.unshift(`Not saved: ${result.error}`);
    renderTodoViewList();
    loadTodoView({ quiet: true, rotate: false });
    return;
  }
  todoViewTake(result);
}

function todoViewFind(id, items = todoViewSections().flatMap(s => s.items)) {
  for (const item of items) {
    if (item.id === id) return item;
    const found = todoViewFind(id, item.children);
    if (found) return found;
  }
  return null;
}

function todoViewSections() {
  return todoViewState.page?.sections || [];
}

function todoViewToggle(id, checked) {
  const item = todoViewFind(id);
  if (item) item.checked = checked; // drawn at once; the save repaints from Notion
  renderTodoViewMain();
  todoViewEdit({ op: 'check', id, checked });
}

function todoViewMoveMenu(id, anchor) {
  const sections = todoViewSections().filter(s => TODO_VIEW_ACTIVE.includes(s.kind));
  showContextMenu(sections.map(s => ({
    label: `Move to ${s.title}`,
    onClick: () => todoViewEdit({ op: 'move', id, sectionId: s.id }),
  })), { anchor });
}

function todoViewDelete(id) {
  const item = todoViewFind(id);
  if (!item) return;
  const subs = item.children.length ? `\n\nIts ${item.children.length} subtask${item.children.length === 1 ? '' : 's'} go too.` : '';
  if (!confirm(`Delete "${item.text}"?${subs}`)) return;
  todoViewEdit({ op: 'delete', id });
}

// --- Drawing ---

function todoViewOpenCount(items) {
  return items.filter(i => i.checked === false).length;
}

function renderTodoViewList() {
  if (!todoViewContent) return;
  const s = todoViewState;
  const page = s.page;
  const status = s.saving ? 'Saving…' : s.loading ? 'Loading…' : page?.fetchedAt ? `Updated ${escapeHtml(formatDate(new Date(page.fetchedAt)))}` : '';
  const sections = todoViewSections().map(sec => {
    const count = sec.kind === 'archive' ? (sec.archived ?? '') : todoViewOpenCount(sec.items);
    return `<div class="tdv-nav" data-section="${todoAttr(sec.id)}"><span class="tdv-nav-title">${escapeHtml(sec.title)}</span><span class="ghv-count">${count}</span></div>`;
  }).join('');
  let body;
  if (s.error) body = `<div class="ghv-empty gh-error">${escapeHtml(s.error)}</div>`;
  else if (page && !page.configured) {
    body = `<div class="ghv-empty">Connect a Notion page to see your todos here.</div>
      <button type="button" class="ws-ghost ws-ghost--sm tdv-setup" id="tdv-setup">Open settings</button>`;
  } else body = sections;
  todoViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-head-title">Todo</span><span class="ws-flex"></span>
      <span class="gh-muted">${status}</span>
      ${page?.pageUrl ? `<button type="button" class="ws-ghost ws-ghost--sm" id="tdv-notion" title="Open the page in Notion">${PICONS.open(12)}</button>` : ''}
      <button type="button" class="ws-ghost ws-ghost--sm" id="tdv-refresh" title="Read the page again">${PICONS.refresh(12)}</button></div>
    ${body}
    ${page?.githubError ? `<div class="ghv-empty gh-error" title="${todoAttr(page.githubError)}">GitHub could not be read, so nothing was checked off.</div>` : ''}
    ${s.notices.length ? `<div class="ghv-section"><div class="ghv-section-h">Lately<span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="tdv-clear" title="Clear">${PICONS.x(10)}</button></div>
      ${s.notices.map(n => `<div class="tdv-notice">${escapeHtml(n)}</div>`).join('')}</div>` : ''}`;
  todoViewContent.querySelector('#tdv-refresh').onclick = () => loadTodoView();
  const notion = todoViewContent.querySelector('#tdv-notion');
  if (notion) notion.onclick = () => window.api.openExternal(page.pageUrl);
  const setup = todoViewContent.querySelector('#tdv-setup');
  if (setup) setup.onclick = () => openSettingsViewer('global');
  const clear = todoViewContent.querySelector('#tdv-clear');
  if (clear) clear.onclick = () => { s.notices = []; renderTodoViewList(); };
  todoViewContent.querySelectorAll('.tdv-nav').forEach(nav => {
    nav.onclick = () => todoViewer.querySelector(`.tdv-section[data-section="${CSS.escape(nav.dataset.section)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

/** A todo's text: its links, and GitHub links as chips that know their state and plan. */
function todoViewText(item) {
  const states = todoViewState.page?.states || {};
  return item.segments.map(seg => {
    let html = escapeHtml(seg.text);
    if (seg.code) html = `<code>${html}</code>`;
    if (seg.bold) html = `<b>${html}</b>`;
    if (seg.italic) html = `<i>${html}</i>`;
    if (seg.strike) html = `<s>${html}</s>`;
    if (!seg.url) return html;
    const gh = seg.url.match(TODO_VIEW_GITHUB);
    if (!gh) return `<a class="tdv-link" href="${todoAttr(seg.url)}" title="${todoAttr(seg.url)}">${html}</a>`;
    const key = `${gh[1]}/${gh[2]}#${gh[4]}`;
    const info = states[key.toLowerCase()];
    const state = (info?.state || 'unknown').toLowerCase();
    const inPlan = todoViewState.planIndex.has(key.toLowerCase());
    const where = inPlan ? 'Open in its project plan' : gh[3].toLowerCase() === 'pull' ? 'Open in the GitHub tab' : 'Open on GitHub';
    const tip = `${key}${info?.title ? `: ${info.title}` : ''}\n${info ? info.state.toLowerCase() : 'state unknown'}\n${where}`;
    return `<a class="tdv-ref tdv-ref--${state}${inPlan ? ' tdv-ref--plan' : ''}" data-key="${todoAttr(key)}" href="${todoAttr(seg.url)}" title="${todoAttr(tip)}"><span class="tdv-ref-dot"></span>${html}${inPlan ? PICONS.chevronRight(9) : ''}</a>`;
  }).join('');
}

function todoViewItem(item) {
  const editing = todoViewState.editing === item.id;
  const adding = todoViewState.adding === item.id;
  const check = item.checked === null ? '<span class="tdv-bullet"></span>'
    : `<input type="checkbox" class="tdv-check" ${item.checked ? 'checked' : ''} title="${item.checked ? 'Mark as not done' : 'Mark as done'}">`;
  const text = editing
    ? `<input type="text" class="tdv-input" data-act="save" value="${todoAttr(item.text)}" spellcheck="false">`
    : `<span class="tdv-text">${todoViewText(item)}</span>`;
  return `<div class="tdv-item${item.checked ? ' tdv-item--done' : ''}" data-id="${todoAttr(item.id)}">
      <div class="tdv-row">${check}${text}
        <span class="tdv-acts">
          <button type="button" class="ws-ghost ws-ghost--sm" data-act="edit" title="Edit">${PICONS.pencil(11)}</button>
          <button type="button" class="ws-ghost ws-ghost--sm" data-act="sub" title="Add a subtask">${PICONS.plus(11)}</button>
          <button type="button" class="ws-ghost ws-ghost--sm" data-act="move" title="Move to another section">${PICONS.chevronRight(11)}</button>
          <button type="button" class="ws-ghost ws-ghost--sm" data-act="delete" title="Delete">${PICONS.trash(11)}</button>
        </span></div>
      ${item.children.length || adding ? `<div class="tdv-children">${item.children.map(todoViewItem).join('')}
        ${adding ? '<div class="tdv-row tdv-row--new"><input type="checkbox" class="tdv-check" disabled><input type="text" class="tdv-input" data-act="add" placeholder="New subtask" spellcheck="false"></div>' : ''}</div>` : ''}
    </div>`;
}

function todoViewSection(sec) {
  if (sec.kind === 'archive') {
    return `<section class="tdv-section tdv-section--archive" data-section="${todoAttr(sec.id)}">
      <div class="tdv-section-h">${escapeHtml(sec.title)}<span class="ghv-count">${sec.archived ?? ''}</span></div>
      <div class="ghv-empty">${sec.archived ?? 'The'} done todos, grouped by week. Open the page in Notion to read them.</div></section>`;
  }
  const adding = todoViewState.adding === sec.id;
  return `<section class="tdv-section" data-section="${todoAttr(sec.id)}">
      <div class="tdv-section-h">${escapeHtml(sec.title)}<span class="ghv-count">${todoViewOpenCount(sec.items)}</span></div>
      ${sec.items.map(todoViewItem).join('') || (adding ? '' : '<div class="ghv-empty">Nothing here.</div>')}
      ${adding ? '<div class="tdv-row tdv-row--new"><input type="checkbox" class="tdv-check" disabled><input type="text" class="tdv-input" data-act="add" placeholder="New todo" spellcheck="false"></div>'
        : `<button type="button" class="tdv-add" data-add="${todoAttr(sec.id)}">${PICONS.plus(11)} Add a todo</button>`}
    </section>`;
}

function renderTodoViewMain() {
  if (!todoViewer || activeTab !== 'todo') return;
  // A repaint while typing would throw the text away.
  if (todoViewer.contains(document.activeElement) && document.activeElement.classList.contains('tdv-input')) return;
  const page = todoViewState.page;
  const scroll = todoViewer.querySelector('.tdv-body')?.scrollTop || 0;
  let body;
  if (!page) body = `<div class="ghv-empty">${todoViewState.error ? escapeHtml(todoViewState.error) : 'Loading…'}</div>`;
  else if (!page.configured) body = '<div class="ghv-empty">No Notion page yet. Add an integration token and the page link in Settings, Notion todo list.</div>';
  else body = todoViewSections().map(todoViewSection).join('');
  todoViewer.innerHTML = `<div class="tdv-body"><div class="tdv-page">${body}</div></div>`;
  todoViewer.querySelector('.tdv-body').scrollTop = scroll;
  bindTodoViewMain();
}

function bindTodoViewMain() {
  todoViewer.querySelectorAll('.tdv-item').forEach(el => {
    const id = el.dataset.id;
    const row = el.querySelector(':scope > .tdv-row');
    const check = row.querySelector('.tdv-check');
    if (check) check.onchange = () => todoViewToggle(id, check.checked);
    row.querySelector('.tdv-text')?.addEventListener('dblclick', () => { todoViewState.editing = id; renderTodoViewMain(); });
    row.querySelectorAll('[data-act]').forEach(btn => {
      if (btn.tagName === 'INPUT') return;
      btn.onclick = (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'edit') { todoViewState.editing = id; renderTodoViewMain(); }
        else if (act === 'sub') { todoViewState.adding = id; renderTodoViewMain(); }
        else if (act === 'move') todoViewMoveMenu(id, btn);
        else if (act === 'delete') todoViewDelete(id);
      };
    });
  });
  todoViewer.querySelectorAll('.tdv-add').forEach(btn => {
    btn.onclick = () => { todoViewState.adding = btn.dataset.add; renderTodoViewMain(); };
  });
  todoViewer.querySelectorAll('a.tdv-ref').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); todoViewOpenRef(a.dataset.key, a.href); };
  });
  todoViewer.querySelectorAll('a.tdv-link').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) window.api.openExternal(a.href); };
  });
  todoViewer.querySelectorAll('input.tdv-input').forEach(input => {
    const done = (save) => {
      if (input._done) return;
      input._done = true;
      const text = input.value.trim();
      const act = input.dataset.act;
      if (act === 'save') {
        const id = input.closest('.tdv-item').dataset.id;
        const item = todoViewFind(id);
        todoViewState.editing = null;
        if (save && text && item && text !== item.text) {
          item.text = text;
          item.segments = [{ text }];
          todoViewEdit({ op: 'text', id, text });
        }
      } else {
        const target = todoViewState.adding;
        todoViewState.adding = null;
        if (save && text) {
          const isSection = todoViewSections().some(s => s.id === target);
          todoViewEdit(isSection ? { op: 'add', sectionId: target, text } : { op: 'add', parentId: target, text });
        }
      }
      input.blur();
      renderTodoViewMain();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
    input.onblur = () => done(true);
  });
  const input = todoViewer.querySelector('input.tdv-input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

/** Called when the Todo tab is opened (app.js). */
function showTodoView() {
  hideAllViewers();
  // hideAllViewers puts the terminal area back; this tab covers it instead.
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  todoViewer.style.display = 'flex';
  renderTodoViewList();
  renderTodoViewMain();
  const fetchedAt = todoViewState.page?.fetchedAt;
  loadTodoView({ quiet: !!fetchedAt });
  clearInterval(todoViewState.timer);
  todoViewState.timer = setInterval(() => {
    if (activeTab !== 'todo') { clearInterval(todoViewState.timer); todoViewState.timer = null; return; }
    if (!todoViewState.saving && !todoViewState.editing && !todoViewState.adding) loadTodoView({ quiet: true });
  }, TODO_VIEW_REFRESH_MS);
}

function hideTodoView() {
  if (todoViewer) todoViewer.style.display = 'none';
}

// The background check (main) checked something off: show it if the list is open.
window.api.onNotionTodoChanged((result) => {
  if (todoViewState.page) todoViewTake(result);
});
