// --- GitHub tab: work tracked on GitHub, read live ---
// A project keeps references only (project.githubRefs): a tracking issue
// whose body links the work items, or a GitHub Project. Their content comes
// from github-tracker.js on every visit and is held in memory, never written.
// Clicking an item opens a review panel beside the list: the PR's description,
// reviews, comments and checks, the auto-rebase label and a merge button.
// Depends on: escapeHtml (utils.js), PICONS, selectedProject, projectTab,
// renderOverview, projectViewer, showContextMenu (projects-view.js),
// formatDate (utils.js), window.marked (codemirror bundle), releaseText,
// releaseDetail, releaseKind, leastReleased (github-releases.js),
// myReviewState, itemReviewGroup, MY_REVIEW_GROUPS (github-my-review.js).

// An eye: someone has been asked to review this pull request.
const GITHUB_REQUESTED_ICON = '<svg class="gh-requested" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-label="review requested"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

// Two branches joining, GitHub's mark for a merged pull request.
const GITHUB_MERGED_ICON = '<svg class="gh-ptab-merged" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="merged"><circle cx="6" cy="5" r="2.6"/><circle cx="6" cy="19" r="2.6"/><circle cx="18" cy="12" r="2.6"/><path d="M6 7.6v8.8"/><path d="M6 7.6c0 2.6 2.4 4.4 5.4 4.4h4"/></svg>';

const GITHUB_GROUPS = [
  { id: 'review', label: 'In review', hint: 'An open pull request is ready for review' },
  { id: 'merged', label: 'Merged, issue open', hint: 'A pull request is merged but the issue is still open' },
  { id: 'progress', label: 'In progress', hint: 'A draft pull request is open' },
  { id: 'todo', label: 'To do', hint: 'No pull request yet' },
  { id: 'done', label: 'Done', hint: 'The issue is closed', collapsed: true },
  { id: 'dropped', label: 'Dropped', hint: 'Closed as not planned', collapsed: true },
];

// projectId → {
//   results: Map<ref, tracker result>, loading: Set<ref>, open: Map<groupKey, bool>,
//   selection: null | { itemKey, view: 'issue' | 'repo#number' },
//   details: Map<'pr:repo#n' | 'issue:repo#n', detail>, detailLoading: Set<key>, busy: string|null,
//   releases: Map<'repo#n', release status> of merged PRs (github-tracker.js getReleaseStatus),
// }
const githubTabStates = new Map();

// The GitHub tab (github-view.js) shows the same PR panel and review outside
// any project. It is a pseudo-project to the code below, drawn in its own
// viewer; everything else looks things up in the window it was drawn in.
const GITHUB_VIEW_PROJECT = { id: '__github__', name: 'GitHub', isGithubView: true, githubRefs: [], folders: [], tracks: [], root: null };

function githubRoot(project) {
  return project?.isGithubView ? document.getElementById('github-viewer') : projectViewer;
}

/** Whether this context's PR views are on screen: its tab, its window. */
function githubContextVisible(project) {
  if (project?.isGithubView) return typeof activeTab !== 'undefined' && activeTab === 'github' && githubRoot(project)?.style.display !== 'none';
  return selectedProject()?.id === project.id && projectTab(project) === 'plan';
}

function githubTabState(projectId) {
  if (!githubTabStates.has(projectId)) {
    githubTabStates.set(projectId, {
      results: new Map(), loading: new Set(), open: new Map(),
      selection: null, details: new Map(), detailLoading: new Set(), busy: null, notice: null,
      releases: new Map(),
    });
  }
  return githubTabStates.get(projectId);
}

/** "MoveLab-Studio/NOHRD-Account" → "NOHRD-Account". */
function githubRepoName(nameWithOwner) {
  return String(nameWithOwner || '').split('/').pop();
}

/** "owner/repo#12" → { owner, repo, number } for the IPC calls. */
function githubTarget(key) {
  const m = String(key).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

// Items of one tracker usually share a "[Topic] " prefix; showing it on every
// row is noise, so a prefix every item carries is dropped.
function sharedTitlePrefix(items) {
  const first = items[0]?.title?.match(/^\[[^\]]+\]\s*/)?.[0];
  return first && items.every(i => i.title.startsWith(first)) ? first : '';
}

function githubChecksDot(state) {
  if (!state) return '';
  const kind = state === 'SUCCESS' ? 'ok' : (state === 'FAILURE' || state === 'ERROR') ? 'fail' : 'pending';
  const text = kind === 'ok' ? 'Checks passed' : kind === 'fail' ? 'Checks failed' : 'Checks running';
  return `<span class="gh-ci gh-ci--${kind}" title="${text}"></span>`;
}

function githubPrChip(pr, itemKey) {
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
  const stateText = { merged: 'Merged', closed: 'Closed', draft: 'Draft', open: 'Open' }[state];
  // A person's review only: movelabbot's approval is a permission check.
  const review = pr.state === 'OPEN' && pr.humanReview
    ? { APPROVED: ['approved', 'Approved'], CHANGES_REQUESTED: ['changes', 'Changes requested'] }[pr.humanReview]
    : null;
  const requested = pr.state === 'OPEN' ? (pr.requested || []) : [];
  const linkText = { closes: 'closes this issue', linked: 'linked in Development', mentions: 'mentions this issue' }[pr.link] || '';
  const mine = githubMineMark(pr);
  const title = `${pr.repo}#${pr.number}: ${pr.title}\n${stateText}${review ? ', ' + review[1].toLowerCase() : ''}, ${linkText}${requested.length ? `\nReview requested from ${requested.join(', ')}` : ''}${mine ? '\n' + mine.text : ''}\nClick to review here`;
  return `<button type="button" class="gh-pr gh-pr--${state}${pr.link === 'mentions' ? ' gh-pr--mention' : ''}" data-item="${escapeHtml(itemKey)}" data-pr="${escapeHtml(`${pr.repo}#${pr.number}`)}" title="${escapeHtml(title)}">`
    + `<span class="gh-pr-num">#${pr.number}</span>`
    + (mine ? `<span class="gh-mine gh-mine--${mine.kind}">${mine.kind === 'reviewed' ? '✓' : '↻'}you</span>` : '')
    + (review ? `<span class="gh-review gh-review--${review[0]}">${review[0] === 'approved' ? '✓' : '±'}</span>` : '')
    + (requested.length ? GITHUB_REQUESTED_ICON : '')
    + githubChecksDot(pr.state === 'OPEN' ? pr.checks : null)
    + '</button>';
}

// --- Release status: which tag a merged PR shipped in (github-releases.js words it) ---

/** The merged PRs that are an item's work: those that close or are linked to it, else any. */
function mergedWorkPrs(item) {
  const all = item.pullRequests || [];
  const direct = all.filter(p => p.link !== 'mentions');
  return (direct.length ? direct : all).filter(p => p.state === 'MERGED' && p.mergeSha);
}

function githubReleasePill(status, extraTitle = '') {
  if (!status || typeof releaseText !== 'function') return '';
  const title = `${releaseDetail(status)}${extraTitle ? '\n' + extraTitle : ''}`;
  return `<span class="gh-rel gh-rel--${releaseKind(status)}" title="${escapeHtml(title)}">${escapeHtml(releaseText(status))}</span>`;
}

/** An issue's release pill: its least released merged PR. */
function githubItemReleasePill(item, releases) {
  if (typeof leastReleased !== 'function') return '';
  const prs = mergedWorkPrs(item);
  const least = leastReleased(prs.map(p => releases.get(`${p.repo}#${p.number}`)));
  if (!least) return '';
  const which = prs.length > 1 ? `Least released of ${prs.map(p => `#${p.number}`).join(', ')}` : '';
  return githubReleasePill(least, which);
}

/** Ask for the release status of merged PRs not known yet (or all of them on a refresh). */
function loadGithubReleases(project, prs, { force = false } = {}) {
  const state = githubTabState(project.id);
  const wanted = prs.filter(p => p.mergeSha && p.mergedAt && (force || !state.releases.has(`${p.repo}#${p.number}`)));
  if (!wanted.length || !window.api.getGithubReleaseStatus) return;
  window.api.getGithubReleaseStatus(wanted.map(p => ({ repo: p.repo, number: p.number, sha: p.mergeSha, mergedAt: p.mergedAt })), { force })
    .then(res => {
      if (!res?.statuses) return;
      for (const [key, status] of Object.entries(res.statuses)) state.releases.set(key, status);
      repaintGithubTabIfShown(project);
      paintGithubPanel(project);
    })
    .catch(() => {});
}

/** Your own review of an open PR, for its chip: reviewed, or changed since. Null when you have not. */
function githubMineMark(pr) {
  if (pr.state !== 'OPEN' || typeof myReviewState !== 'function') return null;
  const kind = myReviewState(pr);
  if (kind === 'none') return null;
  const files = pr.myReview.changedFiles;
  return { kind, text: kind === 'reviewed' ? 'Reviewed by you' : `Changed since your review${files ? ` (${files} file${files === 1 ? '' : 's'})` : ''}` };
}

/** "awaits #2212" or "awaits 3": the blockers of an issue that are still open. Short, so the title keeps its room. */
function githubDepPill(item) {
  const open = openBlockers(item);
  if (!open.length) return '';
  const ref = (d) => `${d.repo === item.repo ? '' : githubRepoName(d.repo)}#${d.number}`;
  const text = open.length > 1 ? `awaits ${open.length}` : `awaits #${open[0].number}`;
  const title = `Waits on, still open:\n${open.map(d => `${ref(d)} ${d.title}`).join('\n')}`;
  return `<span class="gh-dep" title="${githubAttr(title)}">${escapeHtml(text)}</span>`;
}

/** The open PRs that work on an issue (links that only mention it count when there is nothing else). */
function githubOpenPrKeys(item) {
  const all = item.pullRequests || [];
  const direct = all.filter(p => p.link !== 'mentions');
  return (direct.length ? direct : all).filter(p => p.state === 'OPEN').map(p => `${p.repo}#${p.number}`);
}

function githubItemKey(item) {
  return item.number ? `${item.repo}#${item.number}` : `draft:${item.title}`;
}

function githubItemRow(item, prefix, showRepo, selectedKey, releases) {
  const key = githubItemKey(item);
  const title = prefix && item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title;
  const who = item.assignees?.length ? `<span class="gh-item-who" title="Assigned to ${escapeHtml(item.assignees.join(', '))}">${escapeHtml(item.assignees.join(', '))}</span>` : '';
  const ref = item.number ? `${showRepo ? escapeHtml(githubRepoName(item.repo)) : ''}#${item.number}` : 'draft';
  const prs = (item.isPullRequest ? [] : item.pullRequests || []).map(pr => githubPrChip(pr, key)).join('');
  const done = item.status === 'done' || item.status === 'dropped';
  const waits = done ? '' : githubDepPill(item);
  const isIssue = item.number && !item.isPullRequest;
  // ▶ starts a session; ⋯ moves it between phases. Issues are closed by the
  // sessions that do the work, never ticked off here.
  const actions = isIssue
    ? `<span class="gh-item-acts"><button type="button" class="gh-act gh-act-more" title="Phase, open on GitHub">${PICONS.dots(11)}</button><button type="button" class="gh-act gh-act-start" title="Start a session on this issue">${PICONS.play(10)}</button></span>`
    : '';
  return `<div class="gh-item${item.number ? '' : ' gh-item--draft'}${done ? ' gh-item--done' : ''}${key === selectedKey ? ' selected' : ''}" ${item.number ? `data-item="${escapeHtml(key)}"` : ''} title="${escapeHtml(item.title)}${item.number ? '\nClick to review here' : ''}">`
    + `<span class="gh-item-ref">${ref}</span>`
    + `<span class="gh-item-title">${escapeHtml(title)}</span>`
    + `<span class="gh-item-badge"></span>`
    + who
    + waits
    + `<span class="gh-item-prs">${prs}</span>`
    + (releases ? githubItemReleasePill(item, releases) : '')
    + actions
    + '</div>';
}

// --- Grouping: by PR status, or by phase (an issue field, a Project field or milestones) ---

const GITHUB_GROUP_MODE_KEY = (projectId) => `githubGroupMode:${projectId}`;

function githubGroupMode(project) {
  try {
    const mode = localStorage.getItem(GITHUB_GROUP_MODE_KEY(project.id));
    return mode === 'status' || mode === 'mine' ? mode : 'phase';
  } catch { return 'phase'; }
}

function setGithubGroupMode(project, mode) {
  try { localStorage.setItem(GITHUB_GROUP_MODE_KEY(project.id), mode); } catch {}
  paintGithubList(project);
}

const openFirst = (items) => [...items].sort((a, b) => (a.status === 'done' || a.status === 'dropped') - (b.status === 'done' || b.status === 'dropped'));

/** The list's groups for a tracker, in the project's grouping. */
function githubListGroups(project, result) {
  if (githubGroupMode(project) === 'mine' && typeof itemReviewGroup === 'function') {
    return MY_REVIEW_GROUPS.map(g => ({ ...g, items: result.items.filter(i => itemReviewGroup(i) === g.id) })).filter(g => g.items.length);
  }
  if (githubGroupMode(project) === 'status' || typeof githubPhases !== 'function') return githubGroupsFor(result);
  const { by, phases, unphased } = githubPhases(project, result);
  const groups = phases.map(p => ({
    id: 'ph:' + p.title.toLowerCase(), label: p.title, hint: `Phase, from ${phaseSourceLabel(by)}`,
    items: openFirst(p.items), phase: p, collapsed: p.complete || !p.items.length,
  }));
  if (unphased.length) {
    const counted = unphased.filter(i => i.status !== 'dropped');
    groups.push({ id: 'ph:none', label: 'No phase', hint: `Not in a phase (${phaseSourceLabel(by)})`, items: openFirst(unphased),
      phase: { title: null, total: counted.length, done: counted.filter(i => i.status === 'done').length } });
  }
  return groups;
}

function groupByLabel(project, result) {
  if (githubGroupMode(project) === 'mine') return 'Your review';
  if (githubGroupMode(project) === 'status' || typeof githubPhases !== 'function') return 'PR status';
  return phaseSourceLabel(githubPhases(project, result).by);
}

// Project items carry the board's own Status column; group by that when it is
// set, in the order the board's statuses first appear. Otherwise by the
// status derived from the issue and its pull requests.
function githubGroupsFor(result) {
  const byProjectStatus = result.kind === 'project' && result.items.some(i => i.projectStatus);
  if (byProjectStatus) {
    const order = [];
    for (const i of result.items) {
      const name = i.projectStatus || 'No status';
      if (!order.includes(name)) order.push(name);
    }
    return order.map(name => ({ id: 'p:' + name, label: name, hint: 'Status on the GitHub Project', items: result.items.filter(i => (i.projectStatus || 'No status') === name) }));
  }
  return GITHUB_GROUPS.map(g => ({ ...g, items: result.items.filter(i => i.status === g.id) })).filter(g => g.items.length);
}

function githubTrackerCard(project, refText, state) {
  const result = state.results.get(refText);
  const loading = state.loading.has(refText);
  const removeBtn = `<button type="button" class="ws-ghost gh-remove" data-ref="${escapeHtml(refText)}" title="Stop tracking ${escapeHtml(refText)} in this project (nothing on GitHub changes)">${PICONS.x(12)}</button>`;
  const refreshBtn = `<button type="button" class="ws-ghost gh-refresh" data-ref="${escapeHtml(refText)}" title="Fetch the latest from GitHub"${loading ? ' disabled' : ''}>${PICONS.refresh(12)}<span>${loading ? 'Loading…' : 'Refresh'}</span></button>`;

  if (!result) {
    return `<div class="ws-card gh-card"><div class="ws-card-h"><span class="ws-card-title">${escapeHtml(refText)}</span><span class="ws-flex"></span>${refreshBtn}${removeBtn}</div>`
      + `<div class="git-loading"><span class="git-loading-dot"></span>Reading GitHub…</div></div>`;
  }
  if (result.error) {
    return `<div class="ws-card gh-card"><div class="ws-card-h"><span class="ws-card-title">${escapeHtml(refText)}</span><span class="ws-flex"></span>${refreshBtn}${removeBtn}</div>`
      + `<div class="ws-card-text gh-error">${escapeHtml(result.error)}</div></div>`;
  }

  const { summary } = result;
  const pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const repos = new Set(result.items.map(i => i.repo).filter(Boolean));
  const prefix = sharedTitlePrefix(result.items);
  const counts = GITHUB_GROUPS.filter(g => summary.counts[g.id])
    .map(g => `<span class="gh-count gh-count--${g.id}" title="${escapeHtml(g.hint)}">${summary.counts[g.id]} ${escapeHtml(g.label.toLowerCase())}</span>`).join('');
  const fetched = result.fetchedAt ? `Updated ${formatDate(new Date(result.fetchedAt))}` : '';

  let html = `<div class="ws-card gh-card">`
    + `<div class="ws-card-h"><button type="button" class="gh-title" data-url="${escapeHtml(result.url)}" title="Open on GitHub">${escapeHtml(result.title)}</button>`
    + `${result.state === 'CLOSED' ? '<span class="gh-closed">closed</span>' : ''}<span class="ws-flex"></span>`
    + `<span class="gh-viewtoggle" title="The issues as a list, or as a graph of what waits on what">${['list', 'graph'].map(v => `<button type="button" class="ws-ghost${githubPlanView(project) === v ? ' active' : ''}" data-plan-view="${v}">${v === 'list' ? 'List' : 'Graph'}</button>`).join('')}</span>`
    + `<button type="button" class="ws-ghost gh-groupby" data-ref="${escapeHtml(refText)}" title="How the issues are grouped">Group: ${escapeHtml(groupByLabel(project, result))} ${PICONS.chevronDown(10)}</button>`
    // The plan was folded away: this brings it back beside the list.
    + (typeof githubPlanHidden === 'function' && githubPrimaryRef(project) === refText && githubPlanHidden(project) && result.plan
      ? `<button type="button" class="ws-ghost gh-show-plan" title="Show the plan beside the list">Plan</button>` : '')
    + (result.wayfinder && result.state === 'OPEN' && typeof wayfinderNextButton === 'function' ? wayfinderNextButton(refText) : '')
    + `${refreshBtn}${removeBtn}</div>`
    + `<div class="ws-card-row gh-meta"><span class="ws-card-meta mono">${escapeHtml(result.ref)}</span><span class="ws-flex"></span><span class="ws-card-meta" title="${escapeHtml(fetched)}">${escapeHtml(fetched)}</span></div>`
    + `<div class="ws-card-row"><div class="ws-progress ws-progress--sm"><div class="ws-progress-fill" style="width:${pct}%"></div></div><span class="ws-card-meta">${summary.done}/${summary.total} done</span></div>`
    + `<div class="gh-counts">${counts}</div>`;

  const selectedKey = state.selection?.itemKey || null;
  if (githubPlanView(project) === 'graph') {
    html += result.items.length ? githubGraphHtml(project, result, refText, prefix, selectedKey, state) : '';
  } else for (const group of githubListGroups(project, result)) {
    const key = `${refText}|${group.id}`;
    const open = state.open.has(key) ? state.open.get(key) : !group.collapsed;
    const ph = group.phase;
    const phaseBits = ph ? `<span class="ws-flex"></span>`
      + `<div class="ws-progress ws-progress--sm gh-phase-bar"><div class="ws-progress-fill" style="width:${ph.total ? Math.round((ph.done / ph.total) * 100) : 0}%"></div></div>`
      + `<span class="gh-group-n">${ph.done}/${ph.total}</span>`
      + (ph.title ? `<button type="button" class="gh-act gh-group-add" title="New issue in ${escapeHtml(ph.title)}">${PICONS.plus(11)}</button>` : '')
      + (ph.title && group.items.some(i => i.status !== 'done' && i.status !== 'dropped') ? `<button type="button" class="gh-act gh-group-start" title="Start a session on this phase">${PICONS.play(10)}</button>` : '')
      : `<span class="gh-group-n">${group.items.length}</span>`;
    html += `<div class="gh-group${open ? '' : ' collapsed'}" data-key="${escapeHtml(key)}" data-ref="${escapeHtml(refText)}" ${ph?.title ? `data-phase="${escapeHtml(ph.title)}"` : ''}>`
      + `<div class="gh-group-h" role="button" tabindex="0" title="${escapeHtml(group.hint)}"><span class="arrow">&#9660;</span><span>${escapeHtml(group.label)}</span>${phaseBits}</div>`
      + `<div class="gh-group-items">${group.items.map(i => githubItemRow(i, prefix, repos.size > 1, selectedKey, state.releases)).join('')}</div></div>`;
  }
  if (!result.items.length) html += '<div class="ws-card-text muted">No linked issues found. Link issues in its description, or add them as sub-issues.</div>';
  return html + '</div>';
}

// --- Graph: what waits on what, in columns per phase ---

/** escapeHtml for an attribute value: it leaves quotes as they are. */
const githubAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

const GITHUB_PLAN_VIEW_KEY = (projectId) => `githubPlanView:${projectId}`;

function githubPlanView(project) {
  try { return localStorage.getItem(GITHUB_PLAN_VIEW_KEY(project.id)) === 'graph' ? 'graph' : 'list'; } catch { return 'list'; }
}

function setGithubPlanView(project, view) {
  try { localStorage.setItem(GITHUB_PLAN_VIEW_KEY(project.id), view); } catch {}
  paintGithubList(project);
}

/**
 * Columns: the plan's phases, or the depth of the chain when it has none.
 * Blockers from outside the plan get a column of their own, first. A column
 * folds to a narrow strip (a finished phase starts folded); arrows to and
 * from its cards then start or end at the strip.
 */
function githubGraphHtml(project, result, refText, prefix, selectedKey, state) {
  const { edges, outside } = depEdges(result.items);
  const byKey = new Map(result.items.map(i => [depKey(i), i]));
  let columns;
  const phased = typeof githubPhases === 'function' ? githubPhases(project, result) : null;
  if (phased?.phases.length) {
    columns = phased.phases.map(p => ({ id: 'ph:' + p.title, label: p.title, keys: p.items.map(depKey), done: p.complete }));
    if (phased.unphased.length) columns.push({ id: 'ph:none', label: 'No phase', keys: phased.unphased.map(depKey) });
  } else {
    columns = depthColumns(result.items.map(depKey), edges);
  }
  if (outside.size) columns.unshift({ id: 'outside', label: 'Outside the plan', keys: [...outside.keys()] });
  const laid = layoutGraph(columns, edges);
  const card = (key) => {
    const item = byKey.get(key);
    if (!item) {
      const d = outside.get(key);
      return `<button type="button" class="gh-gcard gh-gcard--outside${d.state === 'CLOSED' ? ' gh-gcard--done' : ''}" data-key="${githubAttr(key)}" data-url="${githubAttr(d.url || '')}" title="${githubAttr(`${key} ${d.title || ''}`)}\nNot in this plan: open on GitHub">`
        + `<span class="gh-gcard-ref">${escapeHtml(githubRepoName(d.repo))}#${d.number}</span><span class="gh-gcard-title">${escapeHtml(d.title || '')}</span></button>`;
    }
    const title = prefix && item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title;
    const done = item.status === 'done' || item.status === 'dropped';
    const waits = !done && openBlockers(item).length;
    return `<button type="button" class="gh-gcard gh-gcard--${item.status}${done ? ' gh-gcard--done' : ''}${waits ? ' gh-gcard--waits' : ''}${key === selectedKey ? ' selected' : ''}" data-key="${githubAttr(key)}" data-item="${githubAttr(key)}" title="${githubAttr(item.title)}${waits ? '\nWaits on an open issue' : ''}">`
      + `<span class="gh-gcard-ref">#${item.number}</span><span class="gh-gcard-title">${escapeHtml(title)}</span></button>`;
  };
  const back = laid.edges.filter(e => e.back).length;
  const finished = (key) => {
    const item = byKey.get(key);
    return item ? item.status === 'done' || item.status === 'dropped' : outside.get(key)?.state === 'CLOSED';
  };
  const column = (c) => {
    const openKey = `${refText}|graph:${c.id}`;
    const open = state.open.has(openKey) ? state.open.get(openKey) : !c.done;
    const count = `${c.keys.filter(finished).length}/${c.keys.length}`;
    // Folded, the heading is the whole strip, and stands in for the cards.
    const fold = open ? '' : ` gh-gstub" data-stub="${githubAttr(c.id)}" data-keys="${githubAttr(JSON.stringify(c.keys))}`;
    const head = `<button type="button" class="gh-gcol-h${fold}" data-open-key="${githubAttr(openKey)}" title="${githubAttr(c.label)}\n${open ? 'Click to fold' : 'Click to unfold'}"><span class="arrow">&#9660;</span><span class="gh-gcol-name">${escapeHtml(c.label)}</span><span class="gh-gcol-n">${count}</span></button>`;
    return `<div class="gh-gcol${open ? '' : ' gh-gcol--folded'}">${head}${open ? c.keys.map(card).join('') : ''}</div>`;
  };
  return `<div class="gh-graph" data-ref="${githubAttr(refText)}">`
    + (back ? `<div class="gh-graph-warn">${back} blocker${back === 1 ? ' is' : 's are'} planned after what ${back === 1 ? 'it blocks' : 'they block'} (red arrows)</div>` : '')
    + `<div class="gh-graph-cols">${laid.columns.map(column).join('')}</div>`
    + `<svg class="gh-graph-edges" data-edges="${githubAttr(JSON.stringify(laid.edges))}"></svg></div>`;
}

/** Arrows from each blocker to what it blocks, drawn once the cards are laid out. */
function drawGithubGraphEdges(graph) {
  const svg = graph.querySelector('.gh-graph-edges');
  if (!svg) return;
  const edges = JSON.parse(svg.dataset.edges || '[]');
  const box = graph.getBoundingClientRect();
  const cards = new Map([...graph.querySelectorAll('.gh-gcard')].map(c => [c.dataset.key, c]));
  // A folded column's strip stands in for its cards.
  graph.querySelectorAll('.gh-gstub').forEach(stub => JSON.parse(stub.dataset.keys || '[]').forEach(k => cards.set(k, stub)));
  const drawn = new Set();
  // A point the arrows overflow from: an SVG the size of the graph would add
  // to its scroll area itself, and could leave a scrollbar when it all fits.
  svg.setAttribute('width', 1);
  svg.setAttribute('height', 1);
  const at = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left - box.left + graph.scrollLeft, r: r.right - box.left + graph.scrollLeft, y: r.top - box.top + graph.scrollTop + r.height / 2 };
  };
  svg.innerHTML = edges.map(e => {
    const from = cards.get(e.from), to = cards.get(e.to);
    if (!from || !to) return '';
    // Into or out of a fold: one arrow per pair of ends, none inside one.
    if (from === to) return '';
    const end = (el, key) => el.dataset.stub ? `stub:${el.dataset.stub}` : key;
    const pair = `${end(from, e.from)}>${end(to, e.to)}`;
    if (drawn.has(pair)) return '';
    drawn.add(pair);
    const a = at(from), b = at(to);
    // Same column: out of the left side and back in, in the gap before it.
    // Otherwise from the blocker's right side to the blocked one's left.
    const x1 = e.same ? a.l : a.r, y1 = a.y, x2 = b.l, y2 = b.y;
    const bend = e.same ? 20 : Math.max(24, Math.abs(x2 - x1) / 2);
    const c1 = e.same ? x1 - bend : x1 + bend, c2 = x2 - bend;
    const head = `M${x2 - 6},${y2 - 4} L${x2},${y2} L${x2 - 6},${y2 + 4}`;
    const closed = from.classList.contains('gh-gcard--done') || from.classList.contains('gh-gstub');
    const cls = `gh-gedge${e.back ? ' gh-gedge--back' : ''}${closed ? ' gh-gedge--met' : ''}`;
    return `<g class="${cls}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}"><path d="M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}"/><path d="${head}"/></g>`;
  }).join('');
}

function bindGithubGraph(project, list) {
  const state = githubTabState(project.id);
  list.querySelectorAll('.gh-graph').forEach(graph => {
    drawGithubGraphEdges(graph);
    graph.querySelectorAll('.gh-gcol-h[data-open-key]').forEach(head => {
      head.onclick = () => {
        state.open.set(head.dataset.openKey, head.parentElement.classList.contains('gh-gcol--folded'));
        paintGithubList(project);
      };
    });
    // Cards move with the panel's width and with fonts loading.
    new ResizeObserver(() => drawGithubGraphEdges(graph)).observe(graph);
    graph.querySelectorAll('.gh-gcard').forEach(card => {
      card.onclick = () => {
        if (card.dataset.item) selectGithubItem(project, card.dataset.item, null);
        else if (card.dataset.url) window.api.openExternal(card.dataset.url);
      };
      card.onmouseenter = () => {
        graph.classList.add('gh-graph--focus');
        card.classList.add('gh-gcard--lit');
        graph.querySelectorAll('.gh-gedge').forEach(g => {
          if (g.dataset.from !== card.dataset.key && g.dataset.to !== card.dataset.key) return;
          g.classList.add('gh-gedge--lit');
          const other = g.dataset.from === card.dataset.key ? g.dataset.to : g.dataset.from;
          graph.querySelector(`.gh-gcard[data-key="${CSS.escape(other)}"]`)?.classList.add('gh-gcard--lit');
        });
      };
      card.onmouseleave = () => {
        graph.classList.remove('gh-graph--focus');
        graph.querySelectorAll('.gh-gcard--lit, .gh-gedge--lit').forEach(el => el.classList.remove('gh-gcard--lit', 'gh-gedge--lit'));
      };
    });
  });
}

// --- List ---

function paintGithubList(project) {
  const list = githubRoot(project)?.querySelector('#gh-list');
  if (!list) return;
  const state = githubTabState(project.id);
  const refs = project.githubRefs || [];
  // Keep a half-typed reference and the list's scroll across repaints.
  const typed = list.querySelector('#gh-add-input')?.value || '';
  const hadFocus = document.activeElement?.id === 'gh-add-input';
  const scroll = list.scrollTop;

  list.innerHTML = `
    ${refs.length ? refs.map(r => githubTrackerCard(project, r, state)).join('') : `
      <div class="git-empty-state">
        <div class="git-empty-title">Track work on GitHub</div>
        <div>Add a tracking issue or a GitHub Project. Its issues, pull requests, reviews and checks are read live from GitHub; nothing is copied into the project.</div>
      </div>`}
    <form class="gh-add" id="gh-add">
      <input type="text" class="ws-input mono" id="gh-add-input" spellcheck="false" placeholder="https://github.com/owner/repo/issues/123, owner/repo#123 or a Project URL">
      <button type="submit" class="ws-btn">${PICONS.plus(12)}<span>Track</span></button>
    </form>
    <div class="gh-add-error" id="gh-add-error"></div>`;
  list.scrollTop = scroll;
  const input = list.querySelector('#gh-add-input');
  if (typed) input.value = typed;
  if (hadFocus) input.focus();

  list.querySelectorAll('.gh-title[data-url]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); window.api.openExternal(el.dataset.url); };
  });
  list.querySelectorAll('.gh-item[data-item]').forEach(row => {
    row.onclick = () => selectGithubItem(project, row.dataset.item, null);
    // Hovering a row lights up what it waits on and what waits on it.
    row.onmouseenter = () => {
      const item = findGithubItem(state, row.dataset.item);
      if (!item) return;
      const mark = (deps, cls) => deps.forEach(d => list.querySelectorAll(`.gh-item[data-item="${CSS.escape(depKey(d))}"]`).forEach(r => r.classList.add(cls)));
      mark(item.blockedBy || [], 'gh-item--blocker');
      mark(item.blocking || [], 'gh-item--blocked');
    };
    row.onmouseleave = () => list.querySelectorAll('.gh-item--blocker, .gh-item--blocked').forEach(r => r.classList.remove('gh-item--blocker', 'gh-item--blocked'));
  });
  list.querySelectorAll('.gh-pr[data-pr]').forEach(chip => {
    chip.onclick = (e) => { e.stopPropagation(); selectGithubItem(project, chip.dataset.item, chip.dataset.pr); };
  });
  list.querySelectorAll('.gh-group-h').forEach(h => {
    h.onclick = (e) => {
      if (e.target.closest('button')) return;
      const group = h.parentElement;
      const open = group.classList.toggle('collapsed') === false;
      state.open.set(group.dataset.key, open);
    };
  });
  bindGithubPlanActions(project, list, state);
  list.querySelectorAll('[data-plan-view]').forEach(btn => { btn.onclick = () => setGithubPlanView(project, btn.dataset.planView); });
  bindGithubGraph(project, list);
  list.querySelectorAll('.gh-show-plan').forEach(btn => { btn.onclick = () => setGithubPlanHidden(project, false); });
  list.querySelectorAll('.wf-next').forEach(btn => { btn.onclick = () => pickWayfinderTicket(project, btn.dataset.ref, btn); });
  list.querySelectorAll('.gh-refresh').forEach(btn => {
    btn.onclick = () => loadGithubTracker(project, btn.dataset.ref, { force: true });
  });
  list.querySelectorAll('.gh-remove').forEach(btn => {
    btn.onclick = async () => {
      const ref = btn.dataset.ref;
      if (!confirm(`Stop tracking ${ref} in ${project.name}?\n\nNothing changes on GitHub.`)) return;
      state.results.delete(ref);
      await saveGithubRefs(project, refs.filter(r => r !== ref));
    };
  });
  list.querySelector('#gh-add').onsubmit = async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const saved = await saveGithubRefs(project, [...refs, value]);
    if (saved?.error) list.querySelector('#gh-add-error').textContent = saved.error;
  };
}

/** The tracker result and item behind a row key. */
function findGithubItemWithSource(state, itemKey) {
  for (const result of state.results.values()) {
    const item = result?.items?.find(i => githubItemKey(i) === itemKey);
    if (item) return { item, result };
  }
  return null;
}

// Plan actions on the list: tick, start, phase menu, add to and start a phase,
// the grouping menu, and the "N sessions" badges. They come from
// project-github-source.js, which is loaded after this file.
function bindGithubPlanActions(project, list, state) {
  if (typeof showGithubStartMenu !== 'function') return;
  const rowItem = (el) => findGithubItemWithSource(state, el.closest('.gh-item')?.dataset.item);
  list.querySelectorAll('.gh-act-start').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const found = rowItem(btn);
      if (found) showGithubStartMenu(project, { repo: found.item.repo, prompt: githubItemPrompt(found.result, found.item), itemText: `${found.item.repo}#${found.item.number}`, prs: githubOpenPrKeys(found.item), waits: openBlockers(found.item) }, btn);
    };
  });
  list.querySelectorAll('.gh-act-more').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const found = rowItem(btn);
      if (found) showGithubPhaseMenu(project, found.item, btn);
    };
  });
  list.querySelectorAll('.gh-group').forEach(group => {
    const result = state.results.get(group.dataset.ref);
    const phaseTitle = group.dataset.phase;
    const add = group.querySelector('.gh-group-add');
    if (add && result) add.onclick = () => {
      group.classList.remove('collapsed');
      state.open.set(group.dataset.key, true);
      githubAddTodoField(project, result, group.querySelector('.gh-group-items'), phaseTitle);
    };
    const start = group.querySelector('.gh-group-start');
    if (start && result) start.onclick = (e) => {
      const phase = githubPhases(project, result).phases.find(p => p.title === phaseTitle);
      if (phase) showGithubStartMenu(project, { repo: null, prompt: githubPhasePrompt(result, phase), itemText: null }, e.currentTarget);
    };
  });
  list.querySelectorAll('.gh-groupby').forEach(btn => {
    btn.onclick = (e) => {
      const result = state.results.get(btn.dataset.ref);
      const mode = githubGroupMode(project);
      const current = result ? githubPhases(project, result).by : null;
      showContextMenu([
        { head: 'Group by' },
        { label: 'PR status', icon: mode === 'status' ? PICONS.check(14) : '', onClick: () => setGithubGroupMode(project, 'status') },
        { label: 'Your review', hint: 'needs you, changed, waiting', icon: mode === 'mine' ? PICONS.check(14) : '', onClick: () => setGithubGroupMode(project, 'mine') },
        { sep: true },
        { head: 'Phase' },
        ...phaseSources(result).map(src => ({
          label: src.label,
          hint: src.kind === 'field' ? (src.key.includes('|') ? 'Project field' : 'issue field') : '',
          icon: mode === 'phase' && current && src.kind === current.kind && src.key === current.key ? PICONS.check(14) : '',
          onClick: () => { setGithubGroupMode(project, 'phase'); setGithubPhaseSource(project, src); },
        })),
        ...(githubPrimaryRef(project) === btn.dataset.ref && result?.kind === 'issue' ? [{ sep: true }, { label: 'Fill phases from the plan table\u2026', onClick: () => seedGithubPhases(project) }] : []),
      ], { anchor: e.currentTarget });
    };
  });
  // Which sessions worked on an issue, as on the old Plan tab.
  const links = planState(project);
  if (!links.data && !links.loadingLinks) {
    links.loadingLinks = true;
    loadProjectPlan(project).then(() => { links.loadingLinks = false; paintGithubList(project); paintGithubPanel(project); });
  }
  if (links.data) {
    list.querySelectorAll('.gh-item[data-item]').forEach(row => {
      const badge = linkedBadge(project, links.data, 'todos', row.dataset.item);
      const slot = row.querySelector('.gh-item-badge');
      if (badge && slot) { badge.onclick = ((orig) => (e) => { e.stopPropagation(); orig(e); })(badge.onclick); slot.appendChild(badge); }
    });
  }
}

async function saveGithubRefs(project, refs) {
  const result = await window.api.updateProject(project.id, { githubRefs: refs });
  if (result?.error) return result;
  if (result?.project) project.githubRefs = result.project.githubRefs;
  if (selectedProject()?.id === project.id && projectTab(project) === 'plan') renderOverview();
  return result;
}

function githubTabShown(project) {
  return githubContextVisible(project) && !!githubRoot(project)?.querySelector('#gh-panel, #gh-list');
}

function repaintGithubTabIfShown(project) {
  if (!githubTabShown(project)) return;
  paintGithubList(project);
  renderGithubMeta(project);
}

function loadGithubTracker(project, ref, { force = false } = {}) {
  const state = githubTabState(project.id);
  if (state.loading.has(ref)) return;
  state.loading.add(ref);
  repaintGithubTabIfShown(project);
  window.api.getGithubTracker(ref, { force })
    .then(result => {
      state.results.set(ref, result || { error: 'No answer from GitHub.' });
      // Release status follows the list in, once the merged PRs are known.
      if (result?.items) loadGithubReleases(project, result.items.flatMap(mergedWorkPrs), { force });
    })
    .catch(err => state.results.set(ref, { error: err?.message || String(err) }))
    .finally(() => {
      state.loading.delete(ref);
      repaintGithubTabIfShown(project);
      paintGithubPanel(project);
      // The overview and plan tab read the same fetch (project-github-source.js).
      if (typeof onGithubTrackerLoaded === 'function') onGithubTrackerLoaded(project, ref);
    });
}

/** The tab label's "done/total", from the first tracked reference. */
function renderGithubMeta(project) {
  const meta = githubRoot(project)?.querySelector('#ws-tab-github-meta');
  if (!meta) return;
  const first = (project.githubRefs || [])[0];
  const result = first && githubTabState(project.id).results.get(first);
  meta.textContent = result?.summary ? `${result.summary.done}/${result.summary.total}` : '';
}

function renderProjectGithubTab(project, body) {
  const state = githubTabState(project.id);
  // A PR's files are being reviewed: that view has the whole tab (project-github-review.js).
  if (state.review && typeof paintGithubReview === 'function') { paintGithubReview(project); return; }
  if (project.isGithubView) { renderGithubViewMain(); return; }
  body.className = 'ws-body gh-tab-body';
  body.innerHTML = '<div class="gh-split"><div class="gh-list" id="gh-list"></div><aside class="gh-panel" id="gh-panel"></aside></div>';
  paintGithubList(project);
  paintGithubPanel(project);
  // Fetch what is not on screen yet; the main process caches for two minutes,
  // so returning to the tab is instant and Refresh forces a new read.
  for (const ref of project.githubRefs || []) {
    if (!state.results.has(ref)) loadGithubTracker(project, ref);
  }
  if (state.selection) scheduleGithubPoll(project, 0);
}

/** Fill the tab meta without opening the tab, once per project and session. */
function prefetchGithubMeta(project) {
  const first = (project.githubRefs || [])[0];
  if (!first) return;
  const state = githubTabState(project.id);
  if (state.results.has(first)) { renderGithubMeta(project); return; }
  if (state.loading.has(first)) return;
  loadGithubTracker(project, first);
}

// --- Review panel ---

/** The tracker item behind a key, from whichever tracked reference lists it. */
function findGithubItem(state, itemKey) {
  for (const result of state.results.values()) {
    const item = result?.items?.find(i => githubItemKey(i) === itemKey);
    if (item) return item;
  }
  return null;
}

// The PR to show when an issue is clicked: an open PR that closes or is
// linked to it, else any open one, else the newest. No PR shows the issue.
function primaryPullRequest(item) {
  const prs = item.pullRequests || [];
  const direct = prs.filter(p => p.link !== 'mentions');
  const pool = direct.length ? direct : prs;
  const pick = pool.find(p => p.state === 'OPEN' && !p.isDraft) || pool.find(p => p.state === 'OPEN') || pool[0];
  return pick ? `${pick.repo}#${pick.number}` : null;
}

function selectGithubItem(project, itemKey, prKey) {
  const state = githubTabState(project.id);
  const item = findGithubItem(state, itemKey);
  if (!item) return;
  const view = item.isPullRequest ? itemKey : (prKey || primaryPullRequest(item) || 'issue');
  state.selection = { itemKey, view };
  state.notice = null;
  paintGithubList(project);
  paintGithubPanel(project, { resetScroll: true });
  loadGithubDetail(project);
}

function closeGithubPanel(project) {
  const state = githubTabState(project.id);
  state.selection = null;
  clearTimeout(state.pollTimer);
  paintGithubList(project);
  paintGithubPanel(project);
}

function selectedDetailKey(state) {
  const sel = state.selection;
  if (!sel) return null;
  return sel.view === 'issue' ? `issue:${sel.itemKey}` : `pr:${sel.view}`;
}

async function loadGithubDetail(project, { quiet = false } = {}) {
  const state = githubTabState(project.id);
  const key = selectedDetailKey(state);
  if (!key || state.detailLoading.has(key)) return;
  state.detailLoading.add(key);
  if (!quiet) paintGithubPanel(project);
  const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const target = githubTarget(ref);
  try {
    const detail = kind === 'pr' ? await window.api.getGithubPullRequest(target) : await window.api.getGithubIssue(target);
    state.details.set(key, detail || { error: 'No answer from GitHub.' });
    if (detail?.merged) loadGithubReleases(project, [detail]);
  } catch (err) {
    state.details.set(key, { error: err?.message || String(err) });
  }
  state.detailLoading.delete(key);
  if (selectedDetailKey(state) === key) paintGithubPanel(project);
  scheduleGithubPoll(project);
}

// Keep an open PR live while it is on screen: every 15 s while checks run or
// mergeability is being computed, every 60 s otherwise. Stops when the panel
// closes, the PR is no longer open, or the tab is left.
function scheduleGithubPoll(project, delay) {
  const state = githubTabState(project.id);
  clearTimeout(state.pollTimer);
  const key = selectedDetailKey(state);
  if (!key?.startsWith('pr:')) return;
  const detail = state.details.get(key);
  if (detail && !detail.error && detail.state !== 'OPEN') return;
  const busy = !detail || detail.error || detail.checks?.state === 'PENDING' || detail.checks?.state === 'EXPECTED' || detail.mergeState === 'UNKNOWN'
    || detail.checks?.runs?.some(r => r.status !== 'COMPLETED');
  const wait = delay ?? (busy ? 15000 : 60000);
  state.pollTimer = setTimeout(() => {
    if (!githubTabShown(project) || selectedDetailKey(state) !== key) return;
    loadGithubDetail(project, { quiet: true });
  }, wait);
}

// Markdown from GitHub is untrusted: raw HTML in it is shown as text, never
// rendered, and links only ever open in the browser (see the click handlers).
// Escaping the source up front would double-escape code spans ("&lt;sub&gt;"),
// so marked escapes code itself and its html hook escapes the rest.
let githubMarkedRenderer = null;
function githubMarkdown(text) {
  const src = String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!src) return '<p class="gh-muted">No description.</p>';
  if (!window.marked) return `<pre>${escapeHtml(src)}</pre>`;
  if (!githubMarkedRenderer) {
    githubMarkedRenderer = new window.marked.Renderer();
    githubMarkedRenderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token.text || token.raw || '');
    const link = githubMarkedRenderer.link.bind(githubMarkedRenderer);
    githubMarkedRenderer.link = (token) => (/^\s*(javascript|data|vbscript):/i.test(token.href || '') ? escapeHtml(token.text || '') : link(token));
    const image = githubMarkedRenderer.image.bind(githubMarkedRenderer);
    githubMarkedRenderer.image = (token) => (/^https:\/\//i.test(token.href || '') ? image(token) : escapeHtml(token.text || ''));
  }
  return window.marked.parse(src, { renderer: githubMarkedRenderer });
}

/**
 * Just the first paragraph of a description (headings before it are skipped),
 * or null when that is all there is. Descriptions can run long; the panel
 * shows this much until "Read more".
 */
function githubFirstParagraph(text) {
  const src = String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!src || !window.marked?.lexer) return null;
  githubMarkdown('');
  const tokens = window.marked.lexer(src);
  const blocks = tokens.filter(t => t.type !== 'space');
  const first = blocks.find(t => t.type === 'paragraph') || blocks[0];
  if (!first || blocks.length < 2) return null;
  const part = [first];
  part.links = tokens.links;
  return window.marked.parser(part, { renderer: githubMarkedRenderer });
}

function githubDescriptionHtml(detail, state) {
  const key = `desc:${detail.repo}#${detail.number}`;
  const short = githubFirstParagraph(detail.body);
  const full = !short || !!state.open.get(key);
  return `<div class="gh-desc" data-key="${githubAttr(key)}"><div class="gh-md">${full ? githubMarkdown(detail.body) : short}</div>`
    + (short ? `<button type="button" class="ws-ghost ws-ghost--sm gh-desc-more${full ? ' open' : ''}">${full ? 'Show less' : 'Read more'} ${PICONS.chevronDown(10)}</button>` : '')
    + '</div>';
}

function githubAgo(iso) {
  return iso ? formatDate(new Date(iso)) : '';
}

const MERGE_STATE_TEXT = {
  CLEAN: ['ok', 'Ready to merge'],
  HAS_HOOKS: ['ok', 'Ready to merge (with hooks)'],
  UNSTABLE: ['warn', 'Mergeable, but a non-required check is failing'],
  BLOCKED: ['bad', 'Blocked: a required review or check is missing'],
  BEHIND: ['warn', 'The branch is behind its base'],
  DIRTY: ['bad', 'Merge conflicts'],
  DRAFT: ['warn', 'Still a draft'],
  UNKNOWN: ['pending', 'GitHub is checking mergeability…'],
};
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);
const MERGE_LABELS = { SQUASH: 'Squash and merge', REBASE: 'Rebase and merge', MERGE: 'Create a merge commit' };
const REVIEW_STATE_TEXT = {
  APPROVED: ['ok', 'approved'], CHANGES_REQUESTED: ['bad', 'requested changes'],
  COMMENTED: ['muted', 'commented'], DISMISSED: ['muted', 'dismissed'], PENDING: ['muted', 'pending'],
};

function checkRunState(run) {
  if (run.status !== 'COMPLETED') return ['pending', 'running'];
  const c = run.conclusion;
  if (c === 'SUCCESS') return ['ok', 'passed'];
  if (c === 'SKIPPED' || c === 'NEUTRAL') return ['muted', c.toLowerCase()];
  if (c === 'CANCELLED') return ['muted', 'cancelled'];
  return ['bad', (c || 'failed').toLowerCase().replace('_', ' ')];
}

function githubChecksSection(pr, state) {
  const runs = pr.checks?.runs || [];
  if (!runs.length) return '<div class="gh-sec"><div class="gh-sec-h">Checks</div><div class="gh-muted">No checks on the latest commit.</div></div>';
  const by = { ok: 0, bad: 0, pending: 0, muted: 0 };
  for (const r of runs) by[checkRunState(r)[0]]++;
  const summary = [by.bad && `${by.bad} failing`, by.pending && `${by.pending} running`, by.ok && `${by.ok} passed`, by.muted && `${by.muted} skipped`].filter(Boolean).join(', ');
  const kind = by.bad ? 'bad' : by.pending ? 'pending' : 'ok';
  // Failing and running first, then required, then the rest by name.
  const rank = { bad: 0, pending: 1, ok: 2, muted: 3 };
  const sorted = [...runs].sort((a, b) => rank[checkRunState(a)[0]] - rank[checkRunState(b)[0]] || (b.required - a.required) || a.name.localeCompare(b.name));
  const openKey = `checks:${pr.repo}#${pr.number}`;
  const open = state.open.has(openKey) ? state.open.get(openKey) : kind !== 'ok';
  return `<div class="gh-sec gh-fold${open ? '' : ' collapsed'}" data-key="${escapeHtml(openKey)}">
    <button type="button" class="gh-sec-h gh-fold-h"><span class="arrow">&#9660;</span>Checks <span class="gh-state gh-state--${kind}">${escapeHtml(summary)}</span>
      <span class="gh-muted gh-live" title="Refreshed automatically while this PR is open">live</span></button>
    <div class="gh-fold-body">${sorted.map(r => {
      const [k, text] = checkRunState(r);
      return `<a class="gh-check" href="${escapeHtml(r.url || pr.url)}" title="${escapeHtml(r.name)}: ${text}${r.required ? ' (required)' : ''}"><span class="gh-ci gh-ci--${k === 'bad' ? 'fail' : k === 'pending' ? 'pending' : k === 'ok' ? 'ok' : 'skip'}"></span><span class="gh-check-name">${escapeHtml(r.name)}</span>${r.required ? '<span class="gh-req">required</span>' : ''}<span class="gh-check-state">${text}</span></a>`;
    }).join('')}</div></div>`;
}

// Your own review: GitHub will not let you approve your own PR, so the button
// leaves a marked comment review on the commit shown (github-my-review.js).
function githubMyReviewSection(pr, state) {
  if (pr.state !== 'OPEN' || !pr.headOid || typeof myReviewState !== 'function') return '';
  const kind = myReviewState(pr);
  const mine = pr.myReview;
  const sha = (oid) => `<code>${escapeHtml(String(oid).slice(0, 7))}</code>`;
  let text;
  if (kind === 'none') text = '<span class="gh-state gh-state--warn">Not reviewed by you yet</span>';
  else {
    const when = `${mine.kind === 'approved' ? 'Approved' : 'Reviewed'} by you at ${sha(mine.sha)} <span class="gh-muted">${escapeHtml(githubAgo(mine.at))}</span>`;
    if (kind === 'reviewed') {
      text = `<span class="gh-state gh-state--ok">✓</span> ${when}${mine.sha !== pr.headOid ? '<span class="gh-muted">; rebased since, its files are unchanged</span>' : ''}`;
    } else {
      const files = mine.changedFiles;
      text = `<span class="gh-state gh-state--warn">Changed since your review</span> ${when}${files ? `<span class="gh-muted">; ${files} of its files changed</span>` : ''}`;
    }
  }
  const button = kind === 'reviewed' ? '' : `<button type="button" class="ws-btn gh-mark-reviewed" id="gh-mark-reviewed" ${state.busy ? 'disabled' : ''}
      title="Leaves a comment review on GitHub at ${escapeHtml(pr.headOid.slice(0, 7))}, the commit shown here. Collaborators see it.">${state.busy === 'mark' ? 'Marking…' : kind === 'changed' ? 'Mark reviewed again' : 'Mark reviewed'}</button>`;
  return `<div class="gh-sec gh-myrev"><div class="gh-sec-h">Your review</div><div class="gh-myrev-row"><span class="gh-myrev-text">${text}</span>${button}</div></div>`;
}

function githubReviewsSection(pr, state) {
  // Decided by people; a bot's approval (movelabbot checks merge rights) does not count.
  const decision = pr.humanReview
    ? { APPROVED: ['ok', 'Approved'], CHANGES_REQUESTED: ['bad', 'Changes requested'] }[pr.humanReview]
    : pr.requested.length ? ['pending', 'Waiting for review'] : ['warn', 'No review by a person yet'];
  const rows = pr.reviews.map(r => {
    const [k, text] = REVIEW_STATE_TEXT[r.state] || ['muted', r.state.toLowerCase()];
    return `<div class="gh-review-row${r.ignored ? ' gh-review-row--bot' : ''}" ${r.ignored ? 'title="A permission check, not a code review; it does not count"' : ''}><span class="gh-who">${escapeHtml(r.author)}</span><span class="gh-state gh-state--${r.ignored ? 'muted' : k}">${text}</span>${r.ignored ? '<span class="gh-muted">bot, not a review</span>' : ''}<span class="gh-muted">${escapeHtml(githubAgo(r.at))}</span></div>`;
  });
  const open = pr.state === 'OPEN';
  for (const who of pr.requested) {
    rows.push(`<div class="gh-review-row"><span class="gh-who">${escapeHtml(who)}</span><span class="gh-state gh-state--pending">review requested</span>`
      + (open ? `<button type="button" class="ws-ghost gh-unrequest" data-login="${escapeHtml(who)}" ${state.busy ? 'disabled' : ''} title="Withdraw the review request to ${escapeHtml(who)}">${PICONS.x(11)}</button>` : '')
      + '</div>');
  }
  const requestBtn = open
    ? `<span class="ws-flex"></span><button type="button" class="ws-ghost gh-request-review" id="gh-request-review" ${state.busy ? 'disabled' : ''} title="Ask someone to review this pull request">${state.busy === 'request' ? 'Requesting…' : `${PICONS.plus(11)}<span>Request review</span>`}</button>`
    : '';
  return `<div class="gh-sec"><div class="gh-sec-h gh-reviews-h">Reviews ${decision ? `<span class="gh-state gh-state--${decision[0]}">${decision[1]}</span>` : ''}${requestBtn}</div>
    ${rows.length ? rows.join('') : '<div class="gh-muted">No reviews yet.</div>'}</div>`;
}

/**
 * GitHub's auto-merge: on, with who turned it on and how it merges, or a
 * button to turn it on while the PR cannot merge yet (checks running, review
 * pending). GitHub refuses it on a PR that can merge right now.
 */
function githubAutoMergeHtml(pr, state, method, canMergeNow) {
  const auto = pr.autoMerge;
  if (!auto?.allowed || pr.isDraft) return '';
  if (auto.on) {
    const how = MERGE_LABELS[auto.method] || 'merge';
    return `<span class="gh-state gh-state--ok" title="${githubAttr(`GitHub will ${how.toLowerCase()} once the requirements are met.${auto.by ? ` Turned on by ${auto.by}` : ''}${auto.at ? ` ${githubAgo(auto.at)}` : ''}`)}">Auto-merge on</span>
      <button type="button" class="ws-ghost ws-ghost--sm" id="gh-automerge-off" ${state.busy ? 'disabled' : ''} title="Turn auto-merge off">${state.busy === 'automerge' ? 'Turning off…' : 'Disable'}</button>`;
  }
  if (canMergeNow || !method) return '';
  return `<button type="button" class="ws-btn" id="gh-automerge" ${state.busy ? 'disabled' : ''} title="${githubAttr(`GitHub will ${MERGE_LABELS[method].toLowerCase()} into ${pr.baseRef} by itself once checks and reviews pass`)}">${state.busy === 'automerge' ? 'Enabling…' : 'Enable auto-merge'}</button>`;
}

function githubMergeSection(pr, state, project) {
  const prKey = `${pr.repo}#${pr.number}`;
  const resolving = state.busy === 'resolve' || (!!project && prSessionIds(project, prKey).some(id => prSessionState(id)[0] !== 'stopped'));
  if (pr.merged) {
    const release = state.releases.get(`${pr.repo}#${pr.number}`);
    return `<div class="gh-sec gh-merge"><div class="gh-merge-state"><span class="gh-state gh-state--merged">Merged ${escapeHtml(githubAgo(pr.mergedAt))}</span>${githubReleasePill(release)}</div>`
      + (release ? `<div class="gh-rel-detail">${escapeHtml(releaseDetail(release)).replace(/\n/g, '<br>')}</div>` : '')
      + '</div>';
  }
  if (pr.state !== 'OPEN') return '<div class="gh-sec gh-merge"><span class="gh-state gh-state--bad">Closed without merging</span></div>';
  const [kind, text] = MERGE_STATE_TEXT[pr.isDraft ? 'DRAFT' : pr.mergeState] || ['warn', pr.mergeState];
  const method = state.mergeMethod && pr.mergeMethods.includes(state.mergeMethod) ? state.mergeMethod : pr.mergeMethods[0];
  const can = !pr.isDraft && MERGEABLE_STATES.has(pr.mergeState) && !!method && state.busy !== 'merge';
  const autorebase = pr.autorebase.available ? `
    <label class="gh-toggle" title="Adds or removes the ${escapeHtml(pr.autorebase.label)} label; the AutoRebase workflow keeps the branch on top of ${escapeHtml(pr.baseRef)}">
      <span class="settings-toggle gh-switch"><input type="checkbox" id="gh-autorebase" ${pr.autorebase.on ? 'checked' : ''} ${state.busy === 'autorebase' ? 'disabled' : ''}><span class="settings-toggle-slider"></span></span><span>Auto-rebase</span>
    </label>${pr.autorebase.failed ? '<span class="gh-state gh-state--bad" title="The bot added autorebase:non-rebaseable: the last rebase hit conflicts">rebase failed</span>' : ''}`
    : '<span class="gh-muted" title="This repository has no autorebase:opt-in label">No auto-rebase in this repo</span>';
  return `<div class="gh-sec gh-merge">
    <div class="gh-merge-state"><span class="gh-state gh-state--${kind}">${escapeHtml(text)}</span>
      ${pr.defaultBranch && pr.baseRef !== pr.defaultBranch ? `<span class="gh-state gh-state--warn" title="This PR is stacked: merging lands it in ${escapeHtml(pr.baseRef)}, not ${escapeHtml(pr.defaultBranch)}">Merges into ${escapeHtml(pr.baseRef)}, not ${escapeHtml(pr.defaultBranch)}</span>` : ''}
      ${pr.mergeState === 'DIRTY' || pr.autorebase.failed ? `<span class="ws-flex"></span>
      <button type="button" class="ws-btn" id="gh-resolve" ${resolving ? 'disabled' : ''} title="${resolving ? 'A Claude session is already working on this PR; see below' : `Start a Claude session in your local clone that rebases ${escapeHtml(pr.headRef)} onto ${escapeHtml(pr.baseRef)} in a worktree, resolves the conflicts, runs the tests and force-pushes with lease`}">${ICONS.claude(13)}<span>${resolving ? 'Resolving with Claude\u2026' : 'Resolve conflicts with Claude'}</span></button>` : ''}</div>
    <div class="gh-merge-row">
      ${autorebase}
      <span class="ws-flex"></span>
      ${githubAutoMergeHtml(pr, state, method, can)}
      <div class="gh-merge-btns">
        <button type="button" class="ws-btn ws-btn--primary gh-merge-btn" id="gh-merge" ${can ? '' : 'disabled'} title="${can ? `${MERGE_LABELS[method]} into ${escapeHtml(pr.baseRef)}` : escapeHtml(text)}">${state.busy === 'merge' ? 'Merging…' : MERGE_LABELS[method] || 'Merge'}</button>
        ${pr.mergeMethods.length > 1 ? `<button type="button" class="ws-btn ws-btn--primary gh-merge-more" id="gh-merge-method" title="Choose how to merge">${PICONS.chevronDown(11)}</button>` : ''}
      </div>
    </div>
    ${state.notice ? `<div class="gh-notice gh-notice--${state.notice.kind}">${escapeHtml(state.notice.text)}</div>` : ''}
  </div>`;
}

// --- Resolving conflicts in a Claude session ---

const CLONE_PICKS_KEY = 'githubClonePicks'; // { "owner/repo": "/local/path" } chosen by hand

function clonePicks() {
  try { return JSON.parse(localStorage.getItem(CLONE_PICKS_KEY) || '{}') || {}; } catch { return {}; }
}

function rememberClonePick(repo, path) {
  try { localStorage.setItem(CLONE_PICKS_KEY, JSON.stringify({ ...clonePicks(), [repo.toLowerCase()]: path })); } catch {}
}

/**
 * The local main checkout of `owner/repo`: a folder of this project, any
 * folder Switchboard has sessions in, one picked by hand before, or a folder
 * in ~/Sources. Worktrees are skipped; the session makes its own.
 */
async function findLocalClone(project, repo) {
  const want = repo.toLowerCase();
  const picked = clonePicks()[want];
  const candidates = [...new Set([
    picked,
    project.root,
    ...(project.folders || []).map(f => f.path),
    ...(typeof cachedAllProjects !== 'undefined' ? cachedAllProjects.map(p => p.projectPath) : []),
  ].filter(Boolean))];
  // Main looks in these and in every folder of ~/Sources, skipping worktrees.
  const found = await window.api.findLocalClones([repo], candidates).catch(() => null);
  return (found && !found.error && found[want]) || null;
}

function conflictPrompt(pr) {
  const stacked = pr.defaultBranch && pr.baseRef !== pr.defaultBranch
    ? ` This PR is stacked: its base is ${pr.baseRef}, not ${pr.defaultBranch}; rebase onto ${pr.baseRef}.`
    : '';
  return [
    `Resolve the merge conflicts in pull request ${pr.repo}#${pr.number} (${pr.url}): "${pr.title}".`,
    `Branch \`${pr.headRef}\` conflicts with \`${pr.baseRef}\`.${stacked}`,
    '',
    'Steps:',
    `1. \`git fetch origin\`. Work in a git worktree for \`${pr.headRef}\` under \`.worktrees/\` in this repository (reuse one if it already exists), so the main checkout is left alone. Make sure it is at \`origin/${pr.headRef}\`.`,
    `2. Rebase it onto \`origin/${pr.baseRef}\`. For each conflict, read what both sides meant (this PR's description via \`gh pr view ${pr.number}\`, and the commits on the base that touched the file) and keep the intent of both. Do not drop changes from either side to make a conflict go away.`,
    '3. Run the tests and checks that cover the files you touched, and fix what the rebase broke.',
    `4. Push with \`git push --force-with-lease origin HEAD:${pr.headRef}\`.`,
    pr.autorebase.failed ? `5. Remove the \`autorebase:non-rebaseable\` label: \`gh pr edit ${pr.number} --remove-label autorebase:non-rebaseable\`.` : null,
    '',
    'Finish with a short list of the files that conflicted and how you resolved each one. If a conflict needs a product or design decision, stop and ask me instead of guessing.',
  ].filter(l => l !== null).join('\n');
}

async function resolveConflictsWithClaude(project, pr) {
  const state = githubTabState(project.id);
  if (state.busy === 'resolve') return;
  // Grey the button at once: finding the clone and starting take a moment.
  state.busy = 'resolve';
  paintGithubPanel(project);
  try { await startConflictSession(project, pr, state); } finally {
    state.busy = null;
    paintGithubPanel(project);
  }
}

// --- Sessions on a PR: review it, work through its review, or talk about it ---

// The session never touches the main checkout: the same rule as conflictPrompt.
const prWorktreeLine = (pr) => `Work in a git worktree for \`${pr.headRef}\` under \`.worktrees/\` in this repository (reuse one if it already exists, after \`git fetch origin\`), never in the main checkout.`;

const PR_SESSION_KINDS = {
  // A fresh session has not seen the implementation, which is what a review needs.
  review: {
    label: 'Review',
    hint: 'review-pr, comments on GitHub',
    running: 'Reviewing',
    focus: false,
    prompt: (pr) => `/movelab-claude-skills:review-pr ${pr.url}\n\nTo read the code at the PR's head: ${prWorktreeLine(pr)}`,
  },
  resolve: {
    label: 'Work through the review',
    hint: 'resolve-pr-reviews',
    running: 'Working through the review',
    focus: false,
    prompt: (pr) => `/movelab-claude-skills:resolve-pr-reviews ${pr.url}\n\nBefore you start: ${prWorktreeLine(pr)} Make sure it is at \`origin/${pr.headRef}\`, and run everything from there.`,
  },
  // You type the instruction yourself, so this one comes to the front.
  context: {
    label: 'Session on this PR',
    hint: 'loads the PR, then waits',
    running: 'On this PR',
    focus: true,
    prompt: (pr) => [
      `Context: pull request ${pr.repo}#${pr.number} (${pr.url}): "${pr.title}", branch \`${pr.headRef}\` into \`${pr.baseRef}\`.`,
      `Read it first, review comments included: \`gh pr view ${pr.number} -R ${pr.repo} --comments\` and \`gh pr diff ${pr.number} -R ${pr.repo}\`.`,
      `${prWorktreeLine(pr)} Changes go on that branch and are pushed to it.`,
      '',
      'Then tell me in a few lines what the PR does and where it stands, and wait for my instruction.',
    ].join('\n'),
  },
};

/** Context-menu rows that start each kind of session on an open PR. */
function prSessionMenuRows(project, prKey, { unresolved, itemKey } = {}) {
  return Object.entries(PR_SESSION_KINDS).map(([kind, k]) => ({
    label: k.label,
    hint: kind === 'resolve' && unresolved ? `${unresolved} open thread${unresolved === 1 ? '' : 's'}` : k.hint,
    icon: ICONS.claude(14),
    onClick: () => startPrSessionByKey(project, prKey, kind, itemKey),
  }));
}

/**
 * Start a kind of session on a PR by its key, reading the PR first when it is
 * not on screen. Started from the list (itemKey) in the background, the PR
 * opens in the panel, where the session's status shows.
 */
async function startPrSessionByKey(project, prKey, kind, itemKey) {
  const state = githubTabState(project.id);
  let pr = state.details.get(`pr:${prKey}`);
  if (!pr || pr.error || !pr.headRef) {
    pr = await window.api.getGithubPullRequest(githubTarget(prKey)).catch(err => ({ error: err?.message || String(err) }));
    if (!pr || pr.error) { alert(`Could not read ${prKey}: ${pr?.error || 'no answer from GitHub.'}`); return; }
  }
  const k = PR_SESSION_KINDS[kind];
  await startPrSession(project, pr, state, { prompt: k.prompt(pr), label: k.running, focus: k.focus });
  if (itemKey && !k.focus && state.selection?.view !== prKey) selectGithubItem(project, itemKey, prKey);
  else if (state.selection) paintGithubPanel(project);
}

async function startConflictSession(project, pr, state) {
  return startPrSession(project, pr, state, { prompt: conflictPrompt(pr), label: 'Resolving conflicts', focus: false });
}

async function startPrSession(project, pr, state, { prompt, label, focus }) {
  let clone = await findLocalClone(project, pr.repo);
  if (!clone) {
    if (!confirm(`No local clone of ${pr.repo} found.\n\nPick the folder where it is checked out?`)) return;
    const picked = await window.api.browseFolder();
    if (!picked) return;
    const info = (await window.api.getRepoInfo([picked]).catch(() => null))?.[picked];
    if (!info || `${info.owner}/${info.name}`.toLowerCase() !== pr.repo.toLowerCase()) {
      state.notice = { kind: 'bad', text: `${picked} is not a clone of ${pr.repo}.` };
      paintGithubPanel(project);
      return;
    }
    rememberClonePick(pr.repo, info.root);
    clone = info.root;
  }
  // Filed under this project, started in the repository's own checkout.
  // From the GitHub tab there is no project: it is a plain session there.
  const target = project.isGithubView ? { projectPath: clone } : { ...launchTargetFor(project, null), projectPath: clone };
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = 'claude';
  options.initialPrompt = prompt;
  // The session makes its own worktree under .worktrees/ (see the prompt).
  delete options.worktree;
  delete options.worktreeName;
  // Linked to the PR (as a plan item, so it survives a restart). In the
  // background the PR stays on screen, with the session's status in it.
  const prKey = `${pr.repo}#${pr.number}`;
  if (!project.isGithubView) options.planItem = { file: 'todos', itemText: prKey };
  state.notice = null;
  const sessionId = await launchNewSession(target, options, { focus });
  if (!sessionId) return;
  if (!state.prSessions) state.prSessions = new Map();
  state.prSessions.set(prKey, [sessionId, ...(state.prSessions.get(prKey) || []).filter(id => id !== sessionId)]);
  prSessionLabels.set(sessionId, label);
  // Pick up the stored link for the next restart's list.
  if (!project.isGithubView) loadProjectPlan(project).catch(() => {});
}

// --- Sessions linked to a PR: status and last message, a link to open it ---

/** Sessions on a PR, newest first: started from this panel, and stored links. */
function prSessionIds(project, prKey) {
  const state = githubTabState(project.id);
  const ids = [...(state.prSessions?.get(prKey) || [])];
  const data = typeof planState === 'function' ? planState(project).data : null;
  if (data) for (const { session } of linkedSessions(data, 'todos', prKey)) if (!ids.includes(session.sessionId)) ids.push(session.sessionId);
  return ids.filter(id => openSessions.has(id) || sessionMap.has(id));
}

function prSessionState(sessionId) {
  if (attentionSessions.has(sessionId)) return ['needs', 'needs you'];
  if (sessionBusyState.get(sessionId)) return ['working', 'working'];
  if (responseReadySessions.has(sessionId)) return ['ready', 'finished, unread'];
  if (activePtyIds.has(sessionId) || pendingSessions.has(sessionId)) return ['idle', 'waiting for you'];
  return ['stopped', 'stopped'];
}

const prLastMessages = new Map(); // sessionId → { eventTime, text, activity, at }
const prSessionLabels = new Map(); // sessionId → what it was started for, until it has a title

/** The freshest copy of a session: the list's row once indexed, else the launch stub. */
function currentSession(id) {
  for (const list of [cachedAllProjects, cachedProjects]) {
    for (const p of list || []) {
      const s = p.sessions?.find(x => x.sessionId === id);
      if (s) return s;
    }
  }
  return sessionMap.get(id) || openSessions.get(id)?.session || null;
}

/** What the session is for, as its heading: what it was started for, else its title. */
function prSessionName(id) {
  const session = currentSession(id);
  return prSessionLabels.get(id) || (session && cleanDisplayName(session.name || session.aiTitle)) || 'Claude on this PR';
}

function prSessionRowInner(id) {
  const name = prSessionName(id);
  const [kind, text] = prSessionState(id);
  const glance = prLastMessages.get(id) || {};
  const last = glance.text || '';
  // What it is doing now, while it works; the last message says the rest.
  const live = kind === 'working' || kind === 'idle' || kind === 'needs';
  // Its latest concrete step from the transcript ("Editing …/LoginView.swift").
  // Not the spinner word ("Galloping…") nor the title: they say nothing.
  const activity = live ? (glance.activity || '') : '';
  return `<div class="gh-sess-head">
      <span class="gh-sess-dot gh-sess-dot--${kind}"></span>
      <span class="gh-sess-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="gh-sess-state gh-sess-state--${kind}">${text}</span>
      <span class="ws-flex"></span>
      <button type="button" class="ws-ghost ws-ghost--sm" data-act="open" title="${openSessions.has(id) ? 'Open this session' : 'Resume and open this session'}">Open session ${PICONS.chevronRight(10)}</button>
    </div>
    ${activity ? `<div class="gh-sess-activity gh-sess-activity--${kind}" title="${escapeHtml(activity)}">${escapeHtml(activity)}</div>` : ''}
    ${last ? `<div class="gh-sess-last" title="${escapeHtml(last)}">${typeof renderJsonlText === 'function' ? renderJsonlText(last) : escapeHtml(last)}</div>` : ''}`;
}

/** What an issue waits on and what waits on it, each a link to that issue. */
function githubDepsSection(item, state) {
  const lists = [['Waits on', item.blockedBy || []], ['Blocks', item.blocking || []]].filter(([, deps]) => deps.length);
  if (!lists.length) return '';
  const row = (d) => {
    const inPlan = !!findGithubItem(state, depKey(d));
    const closed = d.state === 'CLOSED';
    return `<button type="button" class="gh-deprow${closed ? ' gh-deprow--closed' : ''}" data-dep="${githubAttr(depKey(d))}" data-url="${githubAttr(d.url || '')}" ${inPlan ? 'data-in-plan' : ''} title="${inPlan ? 'Show it here' : 'Not in this plan: open on GitHub'}">`
      + `<span class="gh-deprow-ref">${d.repo === item.repo ? '' : escapeHtml(githubRepoName(d.repo))}#${d.number}</span>`
      + `<span class="gh-deprow-title">${escapeHtml(d.title || '')}</span>`
      + `<span class="gh-state gh-state--${closed ? 'ok' : 'warn'}">${closed ? 'closed' : 'open'}</span></button>`;
  };
  return `<div class="gh-sec gh-deps">${lists.map(([head, deps]) => `<div class="gh-sec-h">${head}</div>${deps.map(row).join('')}`).join('')}</div>`;
}

function githubSessionsSection(project, pr) {
  const ids = prSessionIds(project, `${pr.repo}#${pr.number}`);
  const open = pr.state === 'OPEN';
  if (!ids.length && !open) return '';
  const start = open ? `<button type="button" class="ws-btn gh-pr-session" id="gh-pr-session" title="Start a Claude session on this PR: review it, work through its review, or one that waits for you">${ICONS.claude(13)}<span>Start session</span>${PICONS.chevronDown(11)}</button>` : '';
  return `<div class="gh-sec gh-sessions"><div class="gh-sec-h">Claude on this PR<span class="ws-flex"></span>${start}</div>${ids.map(id =>
    `<div class="gh-sess-row" data-session="${escapeHtml(id)}">${prSessionRowInner(id)}</div>`).join('')}</div>`;
}

/**
 * Fetch a session's last message again when it has moved since. A working
 * session's event time is pinned for the whole turn, so while it runs the
 * message is read again every few seconds regardless.
 */
async function refreshPrLastMessage(id) {
  const session = currentSession(id);
  const eventTime = session && typeof sessionEventTime === 'function' ? sessionEventTime(session) : 0;
  const cached = prLastMessages.get(id);
  const live = prSessionState(id)[0] !== 'stopped';
  if (cached && cached.eventTime === eventTime && !(live && Date.now() - cached.at > 2500)) return false;
  let result = null;
  try { result = await window.api.getSessionGlance(id); } catch {}
  // Not indexed yet (a session seconds old): try again on the next tick.
  if (!result || result.error) return false;
  const changed = cached?.text !== (result.text || '') || cached?.activity !== (result.activity || '');
  prLastMessages.set(id, { eventTime, text: result.text || '', activity: result.activity || '', at: Date.now() });
  return changed;
}

let prSessionTicker = null;

// Every 3 s while a PR with sessions is on screen: redraw just the session
// rows (status, last message), never the panel, so nothing else moves.
function tickPrSessions(project) {
  clearInterval(prSessionTicker);
  prSessionTicker = setInterval(async () => {
    if (!githubTabShown(project)) { clearInterval(prSessionTicker); prSessionTicker = null; return; }
    // The Resolve button follows the sessions: painted before the running
    // list or the links were known, it is put right here.
    const root = githubRoot(project);
    const resolveBtn = root.querySelector('#gh-resolve');
    const view = githubTabState(project.id).selection?.view;
    if (resolveBtn && view && view !== 'issue') {
      const resolving = githubTabState(project.id).busy === 'resolve' || prSessionIds(project, view).some(id => prSessionState(id)[0] !== 'stopped');
      if (resolveBtn.disabled !== resolving) { paintGithubPanel(project); return; }
    }
    const rows = root.querySelectorAll('#gh-panel .gh-sess-row');
    let liveChanged = false;
    for (const row of rows) {
      const id = row.dataset.session;
      await refreshPrLastMessage(id);
      const live = prSessionState(id)[0] !== 'stopped';
      if (row.dataset.live !== undefined && row.dataset.live !== String(live)) liveChanged = true;
      row.dataset.live = String(live);
      const html = prSessionRowInner(id);
      if (row.innerHTML !== html) { row.innerHTML = html; bindPrSessionRow(row, project); }
    }
    if (liveChanged) paintGithubPanel(project);
  }, 3000);
}

// projectId → { sessionId, selection, label }: a session opened from a PR
// panel; the session strip's back button returns to that PR.
const prReturnTargets = new Map();

function bindPrSessionRow(row, project) {
  const id = row.dataset.session;
  row.querySelector('[data-act="open"]').onclick = () => {
    const session = currentSession(id);
    if (!session) return;
    if (project) {
      const state = githubTabState(project.id);
      const view = state.selection?.view || '';
      prReturnTargets.set(project.id, { sessionId: id, selection: state.selection ? { ...state.selection } : null, label: view.includes('#') ? `PR #${view.split('#')[1]}` : 'Plan' });
    }
    openSession(session);
  };
}

/** The back button of the session strip: to the PR this session was opened from, if any. */
function prReturnFor(project, sessionId) {
  const target = prReturnTargets.get(project.id);
  return target && target.sessionId === sessionId ? target : null;
}

function returnToPr(project) {
  const target = prReturnTargets.get(project.id);
  prReturnTargets.delete(project.id);
  if (target?.selection) githubTabState(project.id).selection = target.selection;
  setProjectTab(project, 'plan');
  showProjectOverview();
}

/**
 * The PR (or task) a session works on, from how it was started: the PR panel's
 * own list, or the stored link a todo or PR launch records. Used by the
 * session strip, so the way to the PR is there however the session was opened.
 * { itemKey, view, label } or null.
 */
function githubLinkForSession(project, sessionId) {
  const state = githubTabState(project.id);
  const keys = [];
  for (const [key, ids] of state.prSessions || []) if (ids.includes(sessionId)) keys.push(key);
  const data = typeof planState === 'function' ? planState(project).data : null;
  for (const link of data?.links || []) if (link.sessionId === sessionId && /#\d+$/.test(link.itemText) && !keys.includes(link.itemText)) keys.push(link.itemText);
  let issueMatch = null;
  for (const key of keys) {
    const k = key.toLowerCase();
    for (const result of state.results.values()) {
      for (const item of result?.items || []) {
        // A PR of a task: open the task with that PR in the panel.
        const pr = (item.pullRequests || []).find(p => `${p.repo}#${p.number}`.toLowerCase() === k);
        if (pr) return { itemKey: githubItemKey(item), view: `${pr.repo}#${pr.number}`, label: `PR #${pr.number}` };
        if (!issueMatch && githubItemKey(item).toLowerCase() === k) {
          issueMatch = { itemKey: githubItemKey(item), view: primaryPullRequest(item) || 'issue', label: `Issue #${item.number}` };
        }
      }
    }
  }
  return issueMatch;
}

/** Show that PR or task on the Plan tab, out of any review that was open. */
function openGithubLink(project, link) {
  const state = githubTabState(project.id);
  state.review = null;
  state.selection = { itemKey: link.itemKey, view: link.view };
  prReturnTargets.delete(project.id);
  setProjectTab(project, 'plan');
  showProjectOverview();
}

function bindGithubSessions(project, panel) {
  const rows = panel.querySelectorAll('.gh-sess-row');
  rows.forEach(row => bindPrSessionRow(row, project));
  // Runs for any PR on screen: sessions and the Resolve button can change
  // even when none is linked yet.
  tickPrSessions(project);
  if (!rows.length) return;
  // Last messages arrive after the first paint; the ticker keeps them current.
  rows.forEach(row => refreshPrLastMessage(row.dataset.session).then(changed => {
    if (changed && row.isConnected) { row.innerHTML = prSessionRowInner(row.dataset.session); bindPrSessionRow(row, project); }
  }));
}

function githubConversation(detail) {
  const comments = detail.comments || [];
  const threads = detail.threads || [];
  const open = threads.filter(t => !t.resolved);
  let html = `<div class="gh-sec"><div class="gh-sec-h">Conversation <span class="gh-muted">${comments.length}</span></div>`;
  html += comments.length ? comments.map(c => {
    const review = c.kind === 'review' ? (REVIEW_STATE_TEXT[c.state] || ['muted', ''])[1] : '';
    return `<div class="gh-comment"><div class="gh-comment-h"><span class="gh-who">${escapeHtml(c.author)}</span>${review ? `<span class="gh-muted">${escapeHtml(review)}</span>` : ''}<span class="ws-flex"></span><a class="gh-muted" href="${escapeHtml(c.url)}">${escapeHtml(githubAgo(c.at))}</a></div><div class="gh-md">${githubMarkdown(c.body)}</div></div>`;
  }).join('') : '<div class="gh-muted">No comments.</div>';
  html += '</div>';
  if (threads.length) {
    html += `<div class="gh-sec"><div class="gh-sec-h">Review threads <span class="gh-muted">${open.length} unresolved of ${threads.length}</span></div>`;
    html += [...open, ...threads.filter(t => t.resolved)].map(t => `
      <details class="gh-thread" ${t.resolved ? '' : 'open'}>
        <summary><span class="gh-path">${escapeHtml(t.path)}${t.line ? ':' + t.line : ''}</span>${t.resolved ? '<span class="gh-muted">resolved</span>' : ''}${t.outdated ? '<span class="gh-muted">outdated</span>' : ''}<span class="ws-flex"></span>${t.comments[0]?.url ? `<button type="button" class="ws-ghost ws-ghost--sm gh-thread-show" data-thread-url="${githubAttr(t.comments[0].url)}" data-path="${githubAttr(t.path)}" title="Show this thread in its file, in Files changed">Show in file ${PICONS.chevronRight(10)}</button>` : ''}</summary>
        ${t.comments.map(c => `<div class="gh-comment"><div class="gh-comment-h"><span class="gh-who">${escapeHtml(c.author)}</span><span class="ws-flex"></span><a class="gh-muted" href="${escapeHtml(c.url)}">${escapeHtml(githubAgo(c.at))}</a></div><div class="gh-md">${githubMarkdown(c.body)}</div></div>`).join('')}
      </details>`).join('');
    html += '</div>';
  }
  return html;
}

function paintGithubPanel(project, { resetScroll = false } = {}) {
  const panel = githubRoot(project)?.querySelector('#gh-panel');
  const split = githubRoot(project)?.querySelector('.gh-split');
  if (!panel || !split) return;
  const state = githubTabState(project.id);
  const sel = state.selection;
  const item = sel && findGithubItem(state, sel.itemKey);
  if (!item && project.isGithubView) {
    panel.innerHTML = '<div class="git-empty-state"><div class="git-empty-title">Pick a pull request</div><div>Yours and the ones waiting for your review are listed on the left.</div></div>';
    return;
  }
  if (!item) {
    // Nothing picked: the side shows the plan itself (project-github-source.js).
    const source = typeof githubSource === 'function' ? githubSource(project) : null;
    const showPlan = !!source && !source.error && !!source.plan && !githubPlanHidden(project);
    split.classList.toggle('has-panel', showPlan);
    panel.innerHTML = '';
    if (showPlan) {
      const card = githubPlanDocCard(project, source, githubPlanState(project));
      card.classList.add('gh-panel-plan');
      panel.appendChild(card);
    }
    return;
  }
  split.classList.add('has-panel');

  const scroll = resetScroll ? 0 : panel.scrollTop;
  const key = selectedDetailKey(state);
  const detail = state.details.get(key);
  const loading = state.detailLoading.has(key);

  // Switch between the issue and each of its PRs.
  const tabs = item.isPullRequest ? '' : `<div class="gh-panel-tabs">
    <button type="button" class="gh-ptab${sel.view === 'issue' ? ' active' : ''}" data-view="issue" title="The issue's description and comments">Issue #${item.number}</button>
    ${(item.pullRequests || []).map(p => `<button type="button" class="gh-ptab${sel.view === `${p.repo}#${p.number}` ? ' active' : ''}" data-view="${escapeHtml(`${p.repo}#${p.number}`)}" title="${escapeHtml(p.title)}${p.state === 'MERGED' ? '\nMerged' : ''}">PR #${p.number}${p.state === 'MERGED' ? GITHUB_MERGED_ICON : ''}</button>`).join('')}
  </div>`;

  let body;
  if (!detail) body = '<div class="git-loading"><span class="git-loading-dot"></span>Reading GitHub…</div>';
  else if (detail.error) body = `<div class="gh-sec gh-error">${escapeHtml(detail.error)}</div>`;
  else if (detail.kind === 'pr') {
    const ref = `${githubRepoName(detail.repo)}#${detail.number}`;
    body = `
      <div class="gh-sec gh-pr-head">
        <div class="gh-pr-meta"><span class="gh-pr-ref">${escapeHtml(ref)}</span><span class="gh-who">${escapeHtml(detail.author)}</span>
          <span><code>${escapeHtml(detail.headRef)}</code> → <code>${escapeHtml(detail.baseRef)}</code></span>
          <span><span class="gh-plus">+${detail.additions}</span> <span class="gh-minus">−${detail.deletions}</span></span>
          <button type="button" class="gh-files-link" id="gh-files-changed" title="Review the changes file by file">${PICONS.file(12)}<span>${detail.changedFiles} file${detail.changedFiles === 1 ? '' : 's'}</span>${PICONS.chevronRight(10)}</button></div>
        ${githubDescriptionHtml(detail, state)}
      </div>
      ${githubMergeSection(detail, state, project)}
      ${githubSessionsSection(project, detail)}
      ${githubChecksSection(detail, state)}
      ${githubMyReviewSection(detail, state)}
      ${githubReviewsSection(detail, state)}
      ${githubConversation(detail)}`;
  } else {
    body = `
      <div class="gh-sec gh-pr-head">
        <div class="gh-pr-meta"><span class="gh-pr-ref">${escapeHtml(githubRepoName(detail.repo))}#${detail.number}</span><span>Opened by <span class="gh-who">${escapeHtml(detail.author)}</span> ${escapeHtml(githubAgo(detail.createdAt))}</span>${(item.pullRequests || []).length ? '' : '<span>no pull request yet</span>'}</div>
        ${githubDescriptionHtml(detail, state)}
      </div>
      ${githubDepsSection(item, state)}
      ${githubConversation(detail)}`;
  }

  // The title leads; a panel still reading shows the list's title for it.
  const url = detail && !detail.error ? detail.url : null;
  let pill = '';
  if (detail && !detail.error) {
    pill = detail.kind === 'pr'
      ? (detail.merged ? 'merged' : detail.state === 'CLOSED' ? 'closed' : detail.isDraft ? 'draft' : 'open')
      : (detail.state === 'CLOSED' ? (detail.stateReason === 'NOT_PLANNED' ? 'closed' : 'merged') : 'open');
  }
  const pillText = detail?.kind === 'issue' && pill === 'merged' ? 'closed' : pill;
  const title = detail && !detail.error ? detail.title : item.title;
  panel.innerHTML = `
    <div class="gh-panel-h">
      <div class="gh-pr-title">${pill ? `<span class="gh-pill gh-pill--${pill}">${pillText}</span>` : ''}${escapeHtml(title || '')}</div>
      ${loading ? '<span class="git-loading-dot" title="Refreshing"></span>' : ''}
      <button type="button" class="ws-ghost" id="gh-panel-refresh" title="Fetch the latest from GitHub">${PICONS.refresh(12)}</button>
      ${url ? `<button type="button" class="ws-ghost" id="gh-panel-open" title="Open on GitHub">GitHub ↗</button>` : ''}
      <button type="button" class="ws-ghost" id="gh-panel-close" title="Close the panel">${PICONS.x(12)}</button>
    </div>
    ${tabs}
    <div class="gh-panel-body">${body}</div>`;
  panel.scrollTop = scroll;

  panel.querySelector('#gh-panel-close').onclick = () => closeGithubPanel(project);
  panel.querySelector('#gh-panel-refresh').onclick = () => loadGithubDetail(project);
  const openBtn = panel.querySelector('#gh-panel-open');
  if (openBtn) openBtn.onclick = () => window.api.openExternal(url);
  panel.querySelectorAll('.gh-ptab').forEach(tab => {
    tab.onclick = () => {
      state.selection = { ...state.selection, view: tab.dataset.view };
      state.notice = null;
      paintGithubPanel(project, { resetScroll: true });
      if (!state.details.has(selectedDetailKey(state))) loadGithubDetail(project);
      else scheduleGithubPoll(project);
    };
  });
  // Links in GitHub content open in the browser, never inside the app.
  panel.querySelectorAll('a[href]').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) window.api.openExternal(a.href); };
  });
  panel.querySelectorAll('.gh-fold-h').forEach(h => {
    h.onclick = () => {
      const fold = h.parentElement;
      state.open.set(fold.dataset.key, fold.classList.toggle('collapsed') === false);
    };
  });
  panel.querySelectorAll('.gh-desc-more').forEach(btn => {
    btn.onclick = () => {
      const key = btn.parentElement.dataset.key;
      state.open.set(key, !state.open.get(key));
      paintGithubPanel(project);
    };
  });
  panel.querySelectorAll('.gh-deprow').forEach(btn => {
    btn.onclick = () => {
      if (btn.hasAttribute('data-in-plan')) selectGithubItem(project, btn.dataset.dep, 'issue');
      else if (btn.dataset.url) window.api.openExternal(btn.dataset.url);
    };
  });
  if (detail?.kind === 'pr' && !detail.error) {
    bindGithubPrActions(project, panel, detail);
    bindGithubSessions(project, panel);
    const filesBtn = panel.querySelector('#gh-files-changed');
    if (filesBtn) filesBtn.onclick = () => openGithubReview(project, `${detail.repo}#${detail.number}`, detail.title);
    // A review thread: its file in Files changed, scrolled to the thread.
    panel.querySelectorAll('.gh-thread-show').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openGithubReview(project, `${detail.repo}#${detail.number}`, detail.title, { path: btn.dataset.path, threadUrl: btn.dataset.threadUrl });
      };
    });
  }
}

function bindGithubPrActions(project, panel, pr) {
  const state = githubTabState(project.id);
  const target = githubTarget(`${pr.repo}#${pr.number}`);
  const toggle = panel.querySelector('#gh-autorebase');
  if (toggle) {
    toggle.onchange = async () => {
      state.busy = 'autorebase';
      paintGithubPanel(project);
      const result = await window.api.setGithubAutorebase(target, toggle.checked);
      state.busy = null;
      state.notice = result?.error ? { kind: 'bad', text: result.error } : null;
      await loadGithubDetail(project, { quiet: true });
      paintGithubPanel(project);
    };
  }
  // Review requests: a change shows in the panel and in the list's chips.
  const setRequest = async (login, on) => {
    state.busy = 'request';
    paintGithubPanel(project);
    const result = await window.api.setGithubReviewRequest(target, login, on);
    state.busy = null;
    state.notice = result?.error ? { kind: 'bad', text: result.error } : null;
    await loadGithubDetail(project, { quiet: true });
    for (const ref of project.githubRefs || []) loadGithubTracker(project, ref, { force: true });
    if (project.isGithubView && typeof loadGithubView === 'function') loadGithubView({ quiet: true });
    paintGithubPanel(project);
  };
  const requestBtn = panel.querySelector('#gh-request-review');
  if (requestBtn) {
    requestBtn.onclick = async (e) => {
      const anchor = e.currentTarget;
      const result = await window.api.getGithubReviewCandidates(target);
      if (result?.error) { state.notice = { kind: 'bad', text: result.error }; paintGithubPanel(project); return; }
      const groups = [['reviewed', 'Ask again'], ['suggested', 'Suggested'], ['other', 'Everyone']];
      const items = [];
      for (const [id, head] of groups) {
        const people = (result.candidates || []).filter(c => c.group === id);
        if (!people.length) continue;
        if (items.length) items.push({ sep: true });
        items.push({ head }, ...people.map(c => ({ label: c.login, hint: c.name || '', onClick: () => setRequest(c.login, true) })));
      }
      // The panel may have been redrawn (live checks) while the list loaded.
      const current = anchor.isConnected ? anchor : githubRoot(project)?.querySelector('#gh-request-review');
      showContextMenu(items.length ? items : [{ head: 'Nobody else can review this' }], { anchor: current || anchor });
    };
  }
  panel.querySelectorAll('.gh-unrequest').forEach(btn => {
    btn.onclick = () => setRequest(btn.dataset.login, false);
  });
  const markBtn = panel.querySelector('#gh-mark-reviewed');
  if (markBtn) {
    markBtn.onclick = async () => {
      state.busy = 'mark';
      paintGithubPanel(project);
      const result = await window.api.markGithubReviewed(target, pr.headOid);
      state.busy = null;
      state.notice = result?.error ? { kind: 'bad', text: result.error } : null;
      await loadGithubDetail(project, { quiet: true });
      // The list's chips and groups show it too.
      for (const ref of project.githubRefs || []) loadGithubTracker(project, ref, { force: true });
      if (project.isGithubView && typeof loadGithubView === 'function') loadGithubView({ quiet: true });
      paintGithubPanel(project);
    };
  }
  const resolveBtn = panel.querySelector('#gh-resolve');
  if (resolveBtn) resolveBtn.onclick = () => resolveConflictsWithClaude(project, pr);
  const sessionBtn = panel.querySelector('#gh-pr-session');
  if (sessionBtn) {
    sessionBtn.onclick = (e) => showContextMenu(
      prSessionMenuRows(project, `${pr.repo}#${pr.number}`, { unresolved: (pr.threads || []).filter(t => !t.resolved).length }),
      { anchor: e.currentTarget });
  }
  const methodBtn = panel.querySelector('#gh-merge-method');
  if (methodBtn) {
    methodBtn.onclick = (e) => showContextMenu(pr.mergeMethods.map(m => ({
      label: MERGE_LABELS[m],
      icon: (state.mergeMethod || pr.mergeMethods[0]) === m ? PICONS.check(14) : '',
      onClick: () => { state.mergeMethod = m; paintGithubPanel(project); },
    })), { anchor: e.currentTarget });
  }
  const setAutoMerge = async (on) => {
    const method = state.mergeMethod && pr.mergeMethods.includes(state.mergeMethod) ? state.mergeMethod : pr.mergeMethods[0];
    if (on && !confirm(`Enable auto-merge?\n\n${pr.repo}#${pr.number}: ${pr.title}\nGitHub will ${MERGE_LABELS[method].toLowerCase()} into ${pr.baseRef} once checks and reviews pass.`)) return;
    state.busy = 'automerge';
    paintGithubPanel(project);
    const result = await window.api.setGithubAutoMerge(target, { on, method });
    state.busy = null;
    state.notice = result?.error ? { kind: 'bad', text: result.error } : { kind: 'ok', text: on ? 'Auto-merge is on.' : 'Auto-merge is off.' };
    await loadGithubDetail(project, { quiet: true });
    paintGithubPanel(project);
  };
  const autoOn = panel.querySelector('#gh-automerge');
  if (autoOn) autoOn.onclick = () => setAutoMerge(true);
  const autoOff = panel.querySelector('#gh-automerge-off');
  if (autoOff) autoOff.onclick = () => setAutoMerge(false);
  const mergeBtn = panel.querySelector('#gh-merge');
  if (mergeBtn) {
    mergeBtn.onclick = async () => {
      const method = state.mergeMethod && pr.mergeMethods.includes(state.mergeMethod) ? state.mergeMethod : pr.mergeMethods[0];
      const stacked = pr.defaultBranch && pr.baseRef !== pr.defaultBranch ? `\n\nThis lands in ${pr.baseRef}, not ${pr.defaultBranch}.` : '';
      if (!confirm(`${MERGE_LABELS[method]}?\n\n${pr.repo}#${pr.number}: ${pr.title}\n${pr.headRef} → ${pr.baseRef}${stacked}`)) return;
      state.busy = 'merge';
      paintGithubPanel(project);
      const result = await window.api.mergeGithubPullRequest(target, { method, expectedHeadOid: pr.headOid });
      state.busy = null;
      state.notice = result?.error ? { kind: 'bad', text: result.error } : { kind: 'ok', text: 'Merged.' };
      await loadGithubDetail(project, { quiet: true });
      // The tracker lists this PR's issue; its status has moved.
      for (const ref of project.githubRefs || []) loadGithubTracker(project, ref, { force: true });
      paintGithubPanel(project);
    };
  }
}

/** On a file-based Plan tab: make a GitHub tracking issue or Project the plan. */
function renderGithubLinkForm(project, container) {
  container.innerHTML = `
    <div class="ws-card gh-link-card">
      <div class="ws-card-h"><span class="ws-card-title">Plan on GitHub</span><span class="ws-card-meta">optional</span></div>
      <div class="ws-card-text muted">Use a tracking issue or a GitHub Project as this project's plan. Its issues become the todos, read live; nothing is copied into the project.</div>
      <form class="gh-add gh-link-form">
        <input type="text" class="ws-input mono" spellcheck="false" placeholder="https://github.com/owner/repo/issues/123, owner/repo#123 or a Project URL">
        <button type="submit" class="ws-btn">${PICONS.plus(12)}<span>Use as plan</span></button>
      </form>
      <div class="gh-add-error"></div>
    </div>`;
  const form = container.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = form.querySelector('input').value.trim();
    if (!value) return;
    const saved = await saveGithubRefs(project, [...(project.githubRefs || []), value]);
    if (saved?.error) container.querySelector('.gh-add-error').textContent = saved.error;
  };
}
