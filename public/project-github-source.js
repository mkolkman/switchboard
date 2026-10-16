// --- GitHub as the project's source ---
// When a project tracks GitHub work (project.githubRefs), the first reference
// is its source of truth: the tracking issue's description (or a Project's
// README) is the plan, GitHub milestones are the phases, the linked issues are
// the todos, and the repositories they live in are the attached folders, via
// their local checkouts in ~/Sources. Edits write back to GitHub; nothing is
// copied into the project folder.
// Depends on: project-github-view.js (githubTabState, loadGithubTracker,
// githubMarkdown, githubTarget, githubRepoName, sharedTitlePrefix,
// githubItemKey), projects-view.js (PICONS, renderOverview, renderSideCards,
// launchTargetFor, showContextMenu, planState, loadProjectPlan, linkedBadge,
// projectTab, setProjectTab, selectedProject, editingInPage, pathBasename),
// dialogs.js (resolveDefaultSessionOptions), app.js (launchNewSession).

function githubPrimaryRef(project) {
  return (project?.githubRefs || [])[0] || null;
}

function isGithubBacked(project) {
  return !!githubPrimaryRef(project);
}

/** The source's last fetch, or null while it has not loaded. */
function githubSource(project) {
  const ref = githubPrimaryRef(project);
  return ref ? githubTabState(project.id).results.get(ref) || null : null;
}

function ensureGithubSource(project) {
  const ref = githubPrimaryRef(project);
  if (!ref) return;
  const state = githubTabState(project.id);
  if (!state.results.has(ref) && !state.loading.has(ref)) loadGithubTracker(project, ref);
}

function refreshGithubSource(project) {
  const ref = githubPrimaryRef(project);
  if (ref) loadGithubTracker(project, ref, { force: true });
}

const githubOpenStatuses = new Set(['review', 'merged', 'progress', 'todo']);

// --- Phases: from an issue field ("Wave") or milestones (github-phases.js) ---

const PHASE_SOURCE_KEY = (projectId) => `githubPhaseSource:${projectId}`;

function savedPhaseSource(project) {
  try { return JSON.parse(localStorage.getItem(PHASE_SOURCE_KEY(project.id)) || 'null'); } catch { return null; }
}

function setGithubPhaseSource(project, by) {
  try { localStorage.setItem(PHASE_SOURCE_KEY(project.id), JSON.stringify({ kind: by.kind, key: by.key || null, name: by.name })); } catch {}
  repaintGithubSourceViews(project);
}

/** The plan's phases with where they come from: { by, def, phases, unphased }. */
function githubPhases(project, source) {
  const by = pickPhaseSource(source, savedPhaseSource(project));
  const def = by.kind === 'field' ? fieldDefinition(source, by.key) : null;
  return { by, def, phases: phasesFrom(source?.items || [], by, def), unphased: unphasedItems(source?.items || [], by, def) };
}

function phaseSourceLabel(by) {
  return by.kind === 'field' ? (by.label || by.name) : 'milestone';
}

/** The phase an item is in, as a title, for the source in use. */
function itemPhaseTitle(item, by) {
  if (by.kind === 'milestone') return item.milestone?.title || null;
  const v = item.fields?.[by.key];
  return v && v.value !== null && v.value !== '' ? String(v.value) : null;
}

/** Every repository the plan touches, the tracking issue's own first. */
function githubPlanRepos(source) {
  const repos = [];
  const add = (r) => { if (r && !repos.some(x => x.toLowerCase() === r.toLowerCase())) repos.push(r); };
  add(source?.repo);
  for (const item of source?.items || []) add(item.repo);
  return repos;
}

// --- Local checkouts, attached automatically ---

const githubClones = new Map(); // projectId → { "owner/name" (lowercased): path | null }
const AUTO_ATTACHED_KEY = (projectId) => `githubAutoAttached:${projectId}`;

function autoAttached(projectId) {
  try { return new Set(JSON.parse(localStorage.getItem(AUTO_ATTACHED_KEY(projectId)) || '[]')); } catch { return new Set(); }
}

function rememberAutoAttached(projectId, paths) {
  try { localStorage.setItem(AUTO_ATTACHED_KEY(projectId), JSON.stringify([...paths])); } catch {}
}

async function loadGithubClones(project, source) {
  const repos = githubPlanRepos(source);
  if (!repos.length) return {};
  const known = [project.root, ...(project.folders || []).map(f => f.path),
    ...(typeof cachedAllProjects !== 'undefined' ? cachedAllProjects.map(p => p.projectPath) : [])];
  const found = await window.api.findLocalClones(repos, known).catch(() => null);
  const clones = found && !found.error ? found : {};
  githubClones.set(project.id, clones);
  return clones;
}

/**
 * Attach the local checkout of every plan repository that is not attached
 * yet. A folder is attached once: if the user detaches it, it stays detached.
 */
async function syncGithubFolders(project, source) {
  const clones = await loadGithubClones(project, source);
  const attachedOnce = autoAttached(project.id);
  const current = new Set((project.folders || []).map(f => f.path));
  let changed = false;
  for (const path of Object.values(clones)) {
    if (!path || current.has(path) || attachedOnce.has(path)) continue;
    const result = await window.api.attachProjectFolder(project.id, { path, mode: 'in-place' });
    if (!result?.error) { attachedOnce.add(path); changed = true; }
  }
  if (changed) rememberAutoAttached(project.id, attachedOnce);
  // The project change notification re-renders the page with the new folders.
}

/** Called by loadGithubTracker when a fetch lands. */
function onGithubTrackerLoaded(project, ref) {
  if (ref !== githubPrimaryRef(project)) return;
  const source = githubSource(project);
  if (source && !source.error) syncGithubFolders(project, source).then(() => repaintGithubSourceViews(project));
  repaintGithubSourceViews(project);
}

function repaintGithubSourceViews(project) {
  if (selectedProject()?.id !== project.id || !projectViewer || projectViewer.style.display === 'none') return;
  // Never redraw under someone typing: a todo field, or the plan being edited.
  if (editingInPage() || githubPlanState(project).editing) {
    if (!projectViewer.querySelector('.gh-plan-editor') && githubPlanState(project).editing && projectTab(project) === 'plan') paintGithubPanel(project);
    return;
  }
  const tab = projectTab(project);
  if (tab === 'overview') {
    const side = projectViewer.querySelector('#ws-side');
    if (side) renderSideCards(project, side);
  } else if (tab === 'plan') {
    repaintGithubTabIfShown(project);
    paintGithubPanel(project);
  }
  renderGithubPlanMeta(project);
}

function renderGithubPlanMeta(project) {
  const meta = projectViewer?.querySelector('#ws-tab-plan-meta');
  const source = githubSource(project);
  const phases = source && !source.error ? githubPhases(project, source).phases.filter(p => p.total) : [];
  if (meta) meta.textContent = phases.length ? `${phases.filter(p => p.complete).length}/${phases.length}` : '';
}

// --- Sessions on a todo or a phase ---

function githubItemPrompt(source, item) {
  return [
    `Work on GitHub issue ${item.repo}#${item.number}: "${item.title}" (${item.url}).`,
    `Read it first, comments included: \`gh issue view ${item.number} -R ${item.repo} --comments\`. It is part of the plan ${source.url}.`,
    'Work in a git worktree on a new branch under `.worktrees/` in this repository, so the main checkout is left alone.',
    `When it is done, open a pull request whose description says "Closes ${item.repo}#${item.number}".`,
  ].join('\n');
}

function githubPhasePrompt(source, phase) {
  const open = phase.items.filter(i => githubOpenStatuses.has(i.status));
  return [
    `Work on the phase "${phase.title}" of the plan ${source.url} ("${source.title}").`,
    `Read the plan first: \`gh issue view ${source.number} -R ${source.repo}\`.`,
    '',
    'Open issues in this phase:',
    ...open.map(i => `- ${i.repo}#${i.number}: ${i.title}`),
    '',
    'Each issue is its own pull request, in a git worktree under `.worktrees/` of its repository. Start with one that nothing else in the phase blocks, and tell me which you picked.',
  ].join('\n');
}

/** Launch Claude or Codex on an item, in the local checkout of its repository. */
async function launchGithubItem(project, track, runtime, { repo, prompt, itemText }) {
  const clones = githubClones.get(project.id) || {};
  const clone = repo ? clones[repo.toLowerCase()] : null;
  const base = launchTargetFor(project, track);
  const target = clone ? { ...base, projectPath: clone } : base;
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = runtime;
  options.initialPrompt = prompt;
  // Same link the todo rows use for "N sessions": the issue ref is the item.
  if (itemText) options.planItem = { file: 'todos', itemText };
  delete options.worktree;
  delete options.worktreeName;
  launchNewSession(target, options);
}

function showGithubStartMenu(project, spec, anchor) {
  const rows = (track) => [
    { label: 'Claude', icon: ICONS.claude(14), onClick: () => launchGithubItem(project, track, 'claude', spec) },
    { label: 'Codex', icon: ICONS.codex(14, 'codex-icon'), onClick: () => launchGithubItem(project, track, 'codex', spec) },
  ];
  const clone = spec.repo ? (githubClones.get(project.id) || {})[spec.repo.toLowerCase()] : null;
  // With an open PR the work is done: the PR's sessions come first, and
  // implementing again sits below them.
  const prs = spec.prs || [];
  const items = [];
  // Still blocked: said first, so a session is not started on it by accident.
  if (spec.waits?.length) items.push({ head: `Waits on ${spec.waits.map(d => `#${d.number}`).join(', ')} (open)` });
  for (const key of prs) {
    const number = key.slice(key.indexOf('#'));
    if (prs.length === 1) items.push({ head: `PR ${number}` }, ...prSessionMenuRows(project, key, { itemKey: spec.itemText }));
    else items.push({ label: `PR ${number}`, icon: PICONS.list(13), submenu: prSessionMenuRows(project, key, { itemKey: spec.itemText }) });
  }
  if (prs.length) items.push({ sep: true });
  items.push({ head: prs.length ? 'Implement again' : clone ? `Start in ${pathBasename(clone)}` : 'Start a session on this' }, ...rows(null));
  const tracks = (project.tracks || []).filter(t => t.status !== 'done');
  if (tracks.length) {
    items.push({ sep: true }, { head: 'In a track' });
    for (const t of tracks) items.push({ label: t.name, icon: PICONS.list(13), submenu: rows(t) });
  }
  showContextMenu(items, { anchor });
}

// --- Writes, each followed by a fresh read ---

async function githubWrite(project, promise) {
  const result = await promise;
  if (result?.error) { alert(result.error); return false; }
  refreshGithubSource(project);
  return true;
}

function renameGithubTodo(project, item, title) {
  return githubWrite(project, window.api.renameGithubIssue(githubTarget(`${item.repo}#${item.number}`), title));
}

/** Put an item in a phase (null: no phase) of whatever source the phases use. */
function moveGithubTodo(project, item, phaseTitle) {
  const by = githubPhases(project, githubSource(project)).by;
  const target = githubTarget(`${item.repo}#${item.number}`);
  return githubWrite(project, by.kind === 'field'
    ? window.api.setGithubField(target, by.key, phaseTitle)
    : window.api.setGithubMilestone(target, phaseTitle));
}

async function addGithubTodo(project, repo, title, phaseTitle) {
  const by = githubPhases(project, githubSource(project)).by;
  const created = await window.api.createGithubTodo(githubPrimaryRef(project), { repo, title, milestone: by.kind === 'milestone' ? phaseTitle : null });
  if (created?.error) { alert(created.error); return false; }
  if (phaseTitle && by.kind === 'field') {
    const set = await window.api.setGithubField(githubTarget(`${repo}#${created.number}`), by.key, phaseTitle);
    if (set?.error) alert(`The issue was created, but its ${by.name} could not be set: ${set.error}`);
  }
  refreshGithubSource(project);
  return true;
}

/** "Move to phase" menu for an item: every phase, none, or a new one. */
function showGithubPhaseMenu(project, item, anchor) {
  const source = githubSource(project);
  const { by, def, phases } = githubPhases(project, source);
  const current = itemPhaseTitle(item, by)?.toLowerCase();
  const items = [{ head: `Phase (${phaseSourceLabel(by)})` }, ...phases.map(p => ({
    label: p.title,
    icon: p.title.toLowerCase() === current ? PICONS.check(14) : '',
    onClick: () => moveGithubTodo(project, item, p.title),
  }))];
  items.push({ sep: true });
  // A single-select's options are set on GitHub; milestones and text take any name.
  if (!(by.kind === 'field' && def?.type === 'single_select')) {
    items.push({ label: 'New phase…', onClick: () => { const t = prompt(`Name of the new phase (${phaseSourceLabel(by)}):`); if (t?.trim()) moveGithubTodo(project, item, t.trim()); } });
  }
  items.push(
    { label: 'No phase', muted: !current, onClick: () => moveGithubTodo(project, item, null) },
    { sep: true },
    { label: 'Open on GitHub', onClick: () => window.api.openExternal(item.url) },
    { label: 'Review here', onClick: () => { setProjectTab(project, 'plan'); renderOverview(); selectGithubItem(project, githubItemKey(item), null); } });
  showContextMenu(items, { anchor });
}

/**
 * Fill the phases from a column of the plan's issue table: the issue field in
 * use (matching its options by name), or milestones created per repository.
 * Shows what it would do first.
 */
async function seedGithubPhases(project) {
  const { by } = githubPhases(project, githubSource(project));
  const column = prompt(`Fill the phases (${phaseSourceLabel(by)}) from which column of the issue table in the plan?`, 'Wave');
  if (!column?.trim()) return;
  const ref = githubPrimaryRef(project);
  const run = (apply) => by.kind === 'field'
    ? window.api.seedGithubField(ref, column.trim(), by.key, { apply })
    : window.api.seedGithubMilestones(ref, column.trim(), { apply });
  const dry = await run(false);
  if (dry?.error) { alert(dry.error); return; }
  const counts = new Map();
  for (const e of dry.plan) counts.set(e.title, (counts.get(e.title) || 0) + 1);
  const repos = new Set(dry.plan.map(e => e.ref.split('#')[0]));
  const summary = [...counts].map(([t, n]) => `  ${t}: ${n} issue${n === 1 ? '' : 's'}`).join('\n');
  const missing = dry.unmatched?.length ? `\n\nNo ${by.name} option matches: ${dry.unmatched.join(', ')}. Those issues are skipped; add the options on GitHub and run this again.` : '';
  const what = by.kind === 'field'
    ? `This sets ${by.name} on ${dry.plan.length} issues in ${repos.size} repositories:`
    : `This creates ${counts.size} milestones in ${repos.size} repositories (where missing) and puts ${dry.plan.length} issues in them:`;
  if (!dry.plan.length) { alert(`Nothing to do.${missing}`); return; }
  if (!confirm(`${what}\n\n${summary}${missing}\n\nGo ahead?`)) return;
  const done = await run(true);
  if (done?.error) { alert(done.error); return; }
  refreshGithubSource(project);
}

// --- Sorting the issues without a phase: Claude picks, Switchboard writes ---

const githubPhaseSorts = new Map(); // projectId → { ref, session, state, waiting }

/** The "No phase" header's button: start a sort, or the sort at work. */
function githubPhaseSortButton(project, refText, items) {
  const sort = githubPhaseSorts.get(project.id);
  if (sort?.ref === refText) {
    const needs = sort.state === 'needs' || sort.waiting;
    return `<button type="button" class="ws-ghost ws-ghost--sm gh-group-sorting${needs ? ' gh-group-sorting--needs' : ''}"${sort.session ? '' : ' disabled'} title="Show the Claude session that sorts these issues">${ICONS.claude(11)}<span>${needs ? 'Claude needs you' : 'Sorting…'}</span></button>`;
  }
  if (sort || !unphasedOpen(items).length) return '';
  return `<button type="button" class="gh-act gh-group-sort" title="Let Claude put these issues in phases, with new phases where none fits. You see the changes before they are made.">${ICONS.claude(11)}</button>`;
}

/**
 * Start a Claude session that reads the plan and its open issues without a
 * phase, and answers with a phase for each (phaseSortPrompt). It runs out of
 * sight; the "Sorting…" button shows it.
 */
async function sortGithubUnphased(project, refText) {
  if (githubPhaseSorts.has(project.id)) return;
  const source = githubTabState(project.id).results.get(refText);
  if (!source?.items) return;
  const phased = githubPhases(project, source);
  if (!unphasedOpen(phased.unphased).length) return;
  githubPhaseSorts.set(project.id, { ref: refText, session: null, state: null });
  repaintGithubTabIfShown(project);
  const target = launchTargetFor(project, null);
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = 'claude';
  options.initialPrompt = phaseSortPrompt(source, phased);
  delete options.worktree;
  delete options.worktreeName;
  const sessionId = await launchNewSession(target, options, { focus: false });
  if (!sessionId) {
    githubPhaseSorts.delete(project.id);
    repaintGithubTabIfShown(project);
    alert('The session that sorts the issues did not start.');
    return;
  }
  prSessionLabels.set(sessionId, 'Sorting issues into phases');
  githubPhaseSorts.get(project.id).session = sessionId;
  repaintGithubTabIfShown(project);
  watchGithubPhaseSort(project, refText, sessionId);
}

/**
 * Every 2 s: follow the sort session; once it has worked and stopped working,
 * its last message holds the phases. An answer without them (a question, say)
 * shows "Claude needs you" and the watch goes on until the session answers
 * again or stops.
 */
function watchGithubPhaseSort(project, refText, sessionId) {
  let worked = false;
  let unanswered = 0;
  let reading = false; // a tick can outlast the next one while it reads the transcript
  const current = () => githubPhaseSorts.get(project.id)?.session === sessionId;
  const finish = (text) => {
    clearInterval(timer);
    githubPhaseSorts.delete(project.id);
    repaintGithubTabIfShown(project);
    if (text) alert(text);
  };
  const timer = setInterval(async () => {
    if (!current()) { clearInterval(timer); return; }
    if (reading) return;
    const sort = githubPhaseSorts.get(project.id);
    const [state] = prSessionState(sessionId);
    if (state !== sort.state) { sort.state = state; repaintGithubTabIfShown(project); }
    if (state === 'working' || state === 'needs') {
      worked = true;
      unanswered = 0;
      if (sort.waiting) { sort.waiting = false; repaintGithubTabIfShown(project); }
      return;
    }
    if (state === 'stopped') { finish('The session that sorts the issues stopped before it answered.'); return; }
    if (!worked) return;
    reading = true;
    const message = await window.api.getSessionLastMessage(sessionId, { full: true }).catch(() => null);
    reading = false;
    if (!current()) return;
    const source = githubTabState(project.id).results.get(refText);
    const found = source?.items && message?.text ? phaseAssignmentsFrom(message.text, githubPhases(project, source)) : null;
    if (!found) {
      // Not indexed yet, or a message from before the answer: give it a few
      // ticks. Then Claude is waiting on you; read again once it has worked.
      if (++unanswered >= 5) { worked = false; sort.waiting = true; repaintGithubTabIfShown(project); }
      return;
    }
    finish(null);
    applyGithubPhaseSort(project, refText, found);
  }, 2000);
}

/** Show what the sort would change, and make the changes once agreed. */
async function applyGithubPhaseSort(project, refText, { assignments, skipped }) {
  const source = githubTabState(project.id).results.get(refText);
  const { by } = githubPhases(project, source);
  const line = ({ item }) => `${item.repo.split('/')[1]}#${item.number} ${item.title}`;
  const fresh = new Set(assignments.filter(a => a.isNew).map(a => a.title));
  const byPhase = new Map();
  for (const a of assignments) byPhase.set(a.title, [...(byPhase.get(a.title) || []), a]);
  const summary = [...byPhase].map(([title, list]) => `${title}${fresh.has(title) ? ' (new)' : ''}\n${list.map(a => `  ${line(a)}`).join('\n')}`).join('\n\n');
  const left = skipped.length ? `\n\nLeft without a phase:\n${skipped.map(s => `  ${line(s)}: ${s.reason}`).join('\n')}` : '';
  if (!assignments.length) { alert(`Claude put no issue in a phase.${left}`); return; }
  const what = fresh.size && by.kind === 'milestone'
    ? `Put ${assignments.length} issue${assignments.length === 1 ? '' : 's'} in a ${phaseSourceLabel(by)}, creating ${fresh.size} new milestone${fresh.size === 1 ? '' : 's'} where missing:`
    : `Put ${assignments.length} issue${assignments.length === 1 ? '' : 's'} in a phase (${phaseSourceLabel(by)}):`;
  if (!confirm(`${what}\n\n${summary}${left}\n\nGo ahead?`)) return;
  // One at a time: a new milestone is made by the first issue that needs it.
  const failed = [];
  for (const a of assignments) {
    const target = githubTarget(`${a.item.repo}#${a.item.number}`);
    const result = await (by.kind === 'field'
      ? window.api.setGithubField(target, by.key, a.title)
      : window.api.setGithubMilestone(target, a.title)).catch(err => ({ error: err?.message || String(err) }));
    if (result?.error) failed.push(`${line(a)}: ${result.error}`);
  }
  loadGithubTracker(project, refText, { force: true });
  if (failed.length) alert(`These issues could not be put in a phase:\n\n${failed.join('\n')}`);
}

// --- Overview: Plan, Todos and Attached Folders from GitHub ---

function githubStatusLine(source) {
  if (!source) return '<div class="git-loading gh-mini-loading"><span class="git-loading-dot"></span>Reading GitHub…</div>';
  if (source.error) return `<div class="ws-card-text gh-error">${escapeHtml(source.error)}</div>`;
  return '';
}

function buildCard(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function githubPlanCard(project, source) {
  const phased = source && !source.error ? githubPhases(project, source) : null;
  const phases = (phased?.phases || []).filter(p => p.total);
  const complete = phases.filter(p => p.complete).length;
  const next = phases.find(p => !p.complete);
  const pct = phases.length ? Math.round((complete / phases.length) * 100) : 0;
  const card = buildCard(`
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Plan</span><span class="ws-card-meta">${phases.length ? `${complete} of ${phases.length} phases` : ''}</span><span class="ws-flex"></span>
        ${source?.url ? `<button type="button" class="ws-ghost ws-ghost--sm" data-act="github" title="${escapeHtml(source.title)}">GitHub ↗</button>` : ''}
        <button type="button" class="ws-ghost ws-ghost--sm" data-act="open" title="Phases and the plan on the Plan tab">Open</button></div>
      ${githubStatusLine(source)}
      ${source && !source.error ? (phases.length ? `
        <div class="ws-progress"><div class="ws-progress-fill" style="width:${pct}%"></div></div>
        <div class="ws-card-row">${next ? `${stateDot('', 'proj-dot--next')}<span class="ws-card-strong">Next: ${escapeHtml(next.title)}</span><span class="ws-card-meta">${next.done}/${next.total}</span>` : `${stateDot('', 'proj-dot--done')}<span class="ws-card-strong">Every phase is done</span>`}</div>`
        : `<div class="ws-card-text muted">No phases yet. Phases come from ${escapeHtml(phaseSourceLabel(phased.by))} on the issues. <button type="button" class="ws-ghost ws-ghost--sm" data-act="seed">Fill phases…</button></div>`) : ''}
    </div>`);
  card.querySelector('[data-act="open"]').onclick = () => { setProjectTab(project, 'plan'); renderOverview(); };
  const gh = card.querySelector('[data-act="github"]');
  if (gh) gh.onclick = () => window.api.openExternal(source.url);
  const seed = card.querySelector('[data-act="seed"]');
  if (seed) seed.onclick = () => seedGithubPhases(project);
  return card;
}

function githubTodoRow(project, source, item, prefix, data) {
  const row = document.createElement('div');
  row.className = 'ws-todo gh-todo';
  const done = item.status === 'done' || item.status === 'dropped';
  const title = prefix && item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title;
  row.classList.toggle('gh-todo--done', done);
  row.innerHTML = `<span class="gh-todo-ref" title="${escapeHtml(item.repo)}#${item.number}">${escapeHtml(githubRepoName(item.repo))}#${item.number}</span>`
    + `<span class="ws-todo-text" title="${escapeHtml(item.title)}\nDouble-click to rename the issue">${escapeHtml(title)}</span>`
    + `<button type="button" class="ws-item-start gh-todo-more" title="Phase, open on GitHub, review">${PICONS.dots(11)}</button>`
    + `<button type="button" class="ws-item-start gh-todo-start" title="Start a session on this issue">${PICONS.play(10)}</button>`;
  const badge = data ? linkedBadge(project, data, 'todos', `${item.repo}#${item.number}`) : null;
  if (badge) row.insertBefore(badge, row.querySelector('.gh-todo-more'));
  const text = row.querySelector('.ws-todo-text');
  text.ondblclick = () => editItemInlineGithub(project, item, text);
  row.querySelector('.gh-todo-more').onclick = (e) => { e.stopPropagation(); showGithubPhaseMenu(project, item, e.currentTarget); };
  row.querySelector('.gh-todo-start').onclick = (e) => {
    e.stopPropagation();
    showGithubStartMenu(project, { repo: item.repo, prompt: githubItemPrompt(source, item), itemText: `${item.repo}#${item.number}` }, e.currentTarget);
  };
  return row;
}

function editItemInlineGithub(project, item, textEl) {
  if (textEl.parentElement?.querySelector('.ws-todo-edit')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ws-input ws-todo-edit';
  input.value = item.title;
  input.spellcheck = false;
  let finished = false;
  const restore = () => { if (finished) return; finished = true; input.replaceWith(textEl); };
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); restore(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const title = input.value.trim();
    if (!title || title === item.title) { restore(); return; }
    input.disabled = true;
    if (await renameGithubTodo(project, item, title)) { finished = true; item.title = title; textEl.textContent = title; input.replaceWith(textEl); }
    else { input.disabled = false; input.focus(); }
  };
  input.onblur = () => { if (!input.disabled) restore(); };
  textEl.replaceWith(input);
  input.focus();
  input.select();
}

/** An input plus a repository picker; Enter creates the issue. */
function githubAddTodoField(project, source, container, milestone = null) {
  if (container.querySelector('.gh-add-todo')) return;
  const repos = githubPlanRepos(source);
  const form = document.createElement('div');
  form.className = 'gh-add-todo';
  form.innerHTML = `<input type="text" class="ws-input ws-todo-input" placeholder="New issue title${milestone ? ` in ${escapeHtml(milestone)}` : ''}">`
    + `<select class="ws-input gh-repo-select" title="Repository the issue is created in">${repos.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(githubRepoName(r))}</option>`).join('')}</select>`;
  const input = form.querySelector('input');
  const select = form.querySelector('select');
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') { form.remove(); return; }
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true; select.disabled = true;
    if (await addGithubTodo(project, select.value, title, milestone)) form.remove();
    else { input.disabled = false; select.disabled = false; input.focus(); }
  };
  container.prepend(form);
  input.focus();
}

function githubTodosCard(project, source) {
  const open = (source?.items || []).filter(i => githubOpenStatuses.has(i.status));
  const doneCount = (source?.items || []).filter(i => i.status === 'done').length;
  const prefix = sharedTitlePrefix(source?.items || []);
  const card = buildCard(`
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Todos</span><span class="ws-card-meta">${open.length ? `${open.length} open` : ''}${doneCount ? ` · ${doneCount} done` : ''}</span><span class="ws-flex"></span>
        ${source && !source.error ? `<button type="button" class="ws-ghost ws-ghost--sm" data-act="add" title="Create a GitHub issue in the plan">${PICONS.plus(11)}<span>Add</span></button>` : ''}</div>
      ${githubStatusLine(source)}
      <div class="gh-todos"></div>
      <div class="ws-card-hint">Issues of the plan on GitHub. Sessions close them as the work lands; Add creates one.</div>
    </div>`);
  const list = card.querySelector('.gh-todos');
  const data = planState(project).data;
  if (source && !source.error) {
    if (!open.length) list.innerHTML = '<div class="ws-card-text muted">Nothing open.</div>';
    for (const item of open.slice(0, 8)) list.appendChild(githubTodoRow(project, source, item, prefix, data));
    if (open.length > 8) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ws-ghost ws-ghost--muted';
      more.textContent = `+ ${open.length - 8} more`;
      more.onclick = () => { setProjectTab(project, 'plan'); renderOverview(); };
      list.appendChild(more);
    }
    card.querySelector('[data-act="add"]').onclick = () => githubAddTodoField(project, source, list);
  }
  return card;
}

function githubFoldersCard(project, source) {
  const clones = githubClones.get(project.id) || {};
  const repos = githubPlanRepos(source);
  const repoPaths = new Set(Object.values(clones).filter(Boolean));
  const others = (project.folders || []).filter(f => !repoPaths.has(f.path));
  const attached = new Set((project.folders || []).map(f => f.path));
  const card = buildCard(`
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Attached Folders</span><span class="ws-card-meta">${repos.length ? `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}` : ''}</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" data-act="attach">${PICONS.plus(11)}<span>Attach</span></button></div>
      ${repos.map(repo => {
        const local = clones[repo.toLowerCase()];
        return `<div class="ws-frow gh-frow" ${local ? `data-path="${escapeHtml(local)}"` : ''} title="${escapeHtml(repo)}${local ? `\n${escapeHtml(local)}` : ''}">
          <span class="ws-frow-icon">${PICONS.folder(13)}</span>
          <span class="ws-frow-name">${escapeHtml(githubRepoName(repo))}</span>
          ${local
            ? `<span class="ws-card-meta mono">${escapeHtml(local.replace(/^\/Users\/[^/]+/, '~'))}${attached.has(local) ? '' : ' · not attached'}</span>`
            : `<button type="button" class="ws-ghost ws-ghost--sm" data-clone="${escapeHtml(repo)}" title="Clone into ~/Sources with gh">Clone</button>`}
        </div>`;
      }).join('')}
      ${others.map(f => `
        <div class="ws-frow" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
          <span class="ws-frow-icon ${f.mode === 'worktree' ? 'is-worktree' : ''}">${f.mode === 'worktree' ? PICONS.branch(13) : PICONS.folder(13)}</span>
          <span class="ws-frow-name">${escapeHtml(pathBasename(f.path))}</span>
          <span class="ws-card-meta mono">${escapeHtml(folderModeText(project, f))}</span>
        </div>`).join('')}
      ${!repos.length && !others.length ? '<div class="ws-card-text muted">No repositories in the plan yet.</div>' : ''}
    </div>`);
  card.querySelector('[data-act="attach"]').onclick = () => attachFolderAsk(project);
  card.querySelectorAll('[data-clone]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Cloning…';
      const result = await window.api.cloneGithubRepo(btn.dataset.clone);
      if (result?.error) { alert(result.error); btn.disabled = false; btn.textContent = 'Clone'; return; }
      await syncGithubFolders(project, source);
      repaintGithubSourceViews(project);
    };
  });
  card.querySelectorAll('.ws-frow[data-path]').forEach(row => {
    row.onclick = () => window.api.openPath(row.dataset.path);
  });
  return card;
}

/** Swap the file-based Plan, Todos and Folders cards for their GitHub versions. */
function applyGithubSideCards(project, side) {
  ensureGithubSource(project);
  const source = githubSource(project);
  const swap = (selector, card) => { const old = side.querySelector(selector)?.closest('.ws-card'); if (old) old.replaceWith(card); };
  swap('#ws-plan-open', githubPlanCard(project, source));
  swap('#ws-todo-add', githubTodosCard(project, source));
  swap('#ws-folders-add', githubFoldersCard(project, source));
}

// --- The plan document: shown beside the list on the Plan tab ---

const githubPlanUi = new Map(); // projectId → { editing: { body, updatedAt } | null }

function githubPlanState(project) {
  if (!githubPlanUi.has(project.id)) githubPlanUi.set(project.id, { open: new Map(), editing: null, showDone: false });
  return githubPlanUi.get(project.id);
}

// The plan beside the list can be folded away so the list gets the full
// width; remembered per project. A selected issue or PR still opens its panel.
const PLAN_HIDDEN_KEY = (projectId) => `githubPlanHidden:${projectId}`;

function githubPlanHidden(project) {
  try { return localStorage.getItem(PLAN_HIDDEN_KEY(project.id)) === '1'; } catch { return false; }
}

function setGithubPlanHidden(project, hidden) {
  try { localStorage.setItem(PLAN_HIDDEN_KEY(project.id), hidden ? '1' : '0'); } catch {}
  paintGithubList(project);
  paintGithubPanel(project);
}

function githubPlanDocCard(project, source, ui) {
  const plan = source.plan || { body: '', editable: false };
  if (ui.editing) {
    const card = buildCard(`
      <div class="ws-card gh-plan-doc gh-plan-editor">
        <div class="ws-card-h"><span class="ws-card-title">Plan</span><span class="ws-card-meta">editing ${escapeHtml(source.kind === 'issue' ? `${source.repo}#${source.number}` : 'Project README')}</span><span class="ws-flex"></span>
          <button type="button" class="ws-ghost ws-ghost--sm" data-act="cancel">Cancel</button>
          <button type="button" class="ws-btn ws-btn--primary" data-act="save">Save to GitHub</button></div>
        <textarea class="ws-input gh-plan-textarea" spellcheck="false"></textarea>
      </div>`);
    const area = card.querySelector('textarea');
    area.value = ui.editing.body;
    area.oninput = () => { ui.editing.body = area.value; };
    card.querySelector('[data-act="cancel"]').onclick = () => {
      if (ui.editing.body !== plan.body && !confirm('Discard your changes to the plan?')) return;
      ui.editing = null;
      repaintGithubSourceViews(project);
    };
    card.querySelector('[data-act="save"]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Saving…';
      const result = await window.api.updateGithubPlan(githubPrimaryRef(project), ui.editing.body, ui.editing.updatedAt);
      if (result?.error) { alert(result.error); e.currentTarget.disabled = false; e.currentTarget.textContent = 'Save to GitHub'; return; }
      ui.editing = null;
      refreshGithubSource(project);
      repaintGithubSourceViews(project);
    };
    setTimeout(() => area.focus(), 0);
    return card;
  }
  const card = buildCard(`
    <div class="ws-card gh-plan-doc">
      <div class="ws-card-h"><span class="ws-card-title">Plan</span><span class="ws-card-meta">${escapeHtml(source.kind === 'issue' ? 'description of the tracking issue' : 'README of the Project')}</span><span class="ws-flex"></span>
        ${plan.editable ? '<button type="button" class="ws-ghost ws-ghost--sm" data-act="edit" title="Edit the plan; saving updates it on GitHub">Edit</button>' : ''}
        <button type="button" class="ws-ghost ws-ghost--sm" data-act="hide" title="Fold the plan away so the list uses the full width">Hide ${PICONS.chevronRight ? PICONS.chevronRight(10) : '\u203a'}</button>
        <button type="button" class="ws-ghost ws-ghost--sm" data-act="github">GitHub ↗</button></div>
      <div class="gh-md gh-plan-md">${githubMarkdown(plan.body)}</div>
    </div>`);
  const edit = card.querySelector('[data-act="edit"]');
  if (edit) edit.onclick = () => { ui.editing = { body: plan.body, updatedAt: plan.updatedAt }; repaintGithubSourceViews(project); };
  card.querySelector('[data-act="github"]').onclick = () => window.api.openExternal(source.url);
  card.querySelector('[data-act="hide"]').onclick = () => setGithubPlanHidden(project, true);
  card.querySelectorAll('.gh-plan-md a[href]').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) window.api.openExternal(a.href); };
  });
  return card;
}

