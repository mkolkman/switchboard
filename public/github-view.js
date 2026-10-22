// --- GitHub tab: your pull requests and the ones waiting for your review ---
// The sidebar lists both, and below them (folded) the latest merged or closed
// ones you opened or were asked to review, read live from GitHub; picking one
// shows the same PR panel the projects' Plan tab has (merge, checks, reviews, Claude
// sessions, Files changed). It runs as the pseudo-project GITHUB_VIEW_PROJECT
// in its own viewer (#github-viewer), so that code needs no second copy.
// Above the lists a search box and filters (product, repo, plan, type)
// narrow all three; each row shows its type (github-pr-filter.js).
// Depends on: project-github-view.js (GITHUB_VIEW_PROJECT, githubTabState,
// githubPrChip, githubItemKey, selectGithubItem, paintGithubPanel,
// renderProjectGithubTab), utils.js (escapeHtml, formatDate), PICONS,
// session-context.js (sessionContexts, leaveSessionSplit),
// github-pr-filter.js (prType, prTypeIcon, prProducts, prPlans, prMatches, filterActive, REPO_PRODUCTS).

const githubViewContent = document.getElementById('github-content');
const githubViewer = document.getElementById('github-viewer');
const GITHUB_VIEW_REFRESH_MS = 2 * 60 * 1000;

const githubViewState = { mine: null, review: null, closed: null, error: null, loading: false, fetchedAt: null, timer: null, filter: null, foldedByHand: new Set(), reviewedByMe: new Map() };
// GitHub's search lags a review behind: a PR you just reviewed stays out of
// Review requested this long, unless asked again since.
const GITHUB_VIEW_REVIEWED_MS = 10 * 60 * 1000;
const GITHUB_VIEW_FOLDS_KEY = 'githubViewFolds';
const GITHUB_VIEW_FILTER_KEY = 'githubViewFilter';

/** The search and filters: the text lives only while the app runs, the rest is remembered. */
function githubViewFilter() {
  if (!githubViewState.filter) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(GITHUB_VIEW_FILTER_KEY) || '{}') || {}; } catch {}
    githubViewState.filter = { q: '', product: saved.product || '', repo: saved.repo || '', plan: saved.plan || '', types: Array.isArray(saved.types) ? saved.types : [] };
  }
  return githubViewState.filter;
}

function setGithubViewFilter(change) {
  const f = Object.assign(githubViewFilter(), change);
  // A new filter opens the sections with matches again, also ones folded by hand.
  githubViewState.foldedByHand.clear();
  // A repo that is not the product's goes when the product changes.
  if ('product' in change && f.repo && f.product && !githubViewItems().some(i => i.repo === f.repo && prProducts(i).includes(f.product))) f.repo = '';
  try { localStorage.setItem(GITHUB_VIEW_FILTER_KEY, JSON.stringify({ product: f.product, repo: f.repo, plan: f.plan, types: f.types })); } catch {}
  renderGithubViewList();
}

/** A review you just submitted: out of Review requested now, and for a while after (see GITHUB_VIEW_REVIEWED_MS). */
function noteGithubReviewedByMe(prKey) {
  const s = githubViewState;
  s.reviewedByMe.set(prKey, Date.now());
  if (s.review) s.review = withoutJustReviewed(s.review);
  syncGithubViewResults();
  renderGithubViewList();
}

function withoutJustReviewed(items) {
  const s = githubViewState;
  for (const [key, at] of s.reviewedByMe) if (Date.now() - at > GITHUB_VIEW_REVIEWED_MS) s.reviewedByMe.delete(key);
  return items.filter(i => !s.reviewedByMe.has(`${i.repo}#${i.number}`));
}

function githubViewItems() {
  return [...(githubViewState.mine || []), ...(githubViewState.review || []), ...(githubViewState.closed || [])];
}

/** Put the lists where the PR panel finds its items (findGithubItem). */
function syncGithubViewResults() {
  const state = githubTabState(GITHUB_VIEW_PROJECT.id);
  // A PR opened from elsewhere (the Todo tab) stays findable across refreshes.
  const opened = state.results.get('github-opened');
  state.results = new Map([['github-view', { items: githubViewItems() }]]);
  if (opened) state.results.set('github-opened', opened);
}

/**
 * Open any PR in this tab's panel, also one that is not in its lists.
 * The panel reads the PR itself; the item here only has to exist.
 */
function openGithubViewPullRequest(key, { url = '', title = '' } = {}) {
  const target = githubTarget(key);
  if (!target) return;
  const repo = `${target.owner}/${target.repo}`;
  const tab = document.querySelector('.sidebar-tab[data-tab="github"]');
  if (tab && activeTab !== 'github') tab.click();
  if (!findGithubItem(githubTabState(GITHUB_VIEW_PROJECT.id), key)) {
    const pr = { repo, number: target.number, title: title || `#${target.number}`, url, state: 'OPEN', link: 'linked' };
    const opened = githubTabState(GITHUB_VIEW_PROJECT.id).results.get('github-opened') || { items: [] };
    opened.items = [...opened.items.filter(i => githubItemKey(i) !== key),
      { repo, number: target.number, title: pr.title, url, isPullRequest: true, pullRequests: [pr], status: 'open' }];
    githubTabState(GITHUB_VIEW_PROJECT.id).results.set('github-opened', opened);
  }
  openGithubViewItem(key, key);
}

async function loadGithubView({ quiet = false } = {}) {
  if (githubViewState.loading) return;
  githubViewState.loading = true;
  if (!quiet) renderGithubViewList();
  const result = await window.api.getMyGithubPullRequests().catch(err => ({ error: err?.message || String(err) }));
  githubViewState.loading = false;
  if (result?.error) githubViewState.error = result.error;
  else {
    // A list GitHub could not give this time keeps what it had, and says so.
    const missing = result.missing || [];
    githubViewState.error = missing.length ? `GitHub did not answer for ${missing.join(' and ')}; showing the last list.` : null;
    if (!missing.includes('My pull requests') || !githubViewState.mine) githubViewState.mine = result.mine || [];
    if (!missing.includes('Review requested') || !githubViewState.review) githubViewState.review = withoutJustReviewed(result.review || []);
    if (!missing.includes('Merged or closed') || !githubViewState.closed) githubViewState.closed = result.closed || [];
    githubViewState.fetchedAt = result.fetchedAt;
    applyGithubMapPlans();
    syncGithubViewResults();
    loadGithubMapPlans();
  }
  renderGithubViewList();
  // A PR on screen is refreshed with the list.
  if (activeTab === 'github' && !githubTabState(GITHUB_VIEW_PROJECT.id).review) paintGithubPanel(GITHUB_VIEW_PROJECT);
}

/**
 * The plans for the filter: every open wayfinder map in the repos of the
 * lists, and per PR the maps whose tickets it works on (project-maps.js).
 * Read after the lists, as it takes a while; the filter fills in when it is there.
 */
async function loadGithubMapPlans() {
  // The product repos always, so every map shows, also one with no PR in the lists yet.
  const repos = [...new Set([...Object.keys(REPO_PRODUCTS).map(r => `MoveLab-Studio/${r}`), ...githubViewItems().map(i => i.repo)])];
  const result = await window.api.getGithubMapPlans({ repos }).catch(() => null);
  if (!result || result.error) return;
  githubViewState.maps = result.maps || [];
  githubViewState.mapPlans = result.plans || {};
  applyGithubMapPlans();
  renderGithubViewList();
}

function applyGithubMapPlans() {
  for (const item of githubViewItems()) item.mapPlans = githubViewState.mapPlans?.[`${item.repo}#${item.number}`.toLowerCase()] || [];
}

function githubViewRow(item, selectedKey) {
  const key = githubItemKey(item);
  const pr = item.pullRequests[0];
  const type = prType(item);
  return `<div class="ghv-row${key === selectedKey ? ' selected' : ''}" data-item="${escapeHtml(key)}" title="${escapeHtml(`${item.repo}#${item.number}: ${item.title}`)}">
      <div class="ghv-row-title">${escapeHtml(item.title)}</div>
      <div class="ghv-row-meta"><span class="ghv-type ghv-type--${type.type}" title="${escapeHtml(`${PR_TYPE_LABELS[type.type]}: ${type.reason}`)}" aria-label="${escapeHtml(PR_TYPE_LABELS[type.type])}">${prTypeIcon(type.type)}</span><span class="ghv-row-ref">${escapeHtml(githubRepoName(item.repo))}</span>
        ${item.author && item.author !== 'ghost' ? `<span class="ghv-row-author">${escapeHtml(item.author)}</span>` : ''}
        <span class="ws-flex"></span>${githubPrChip(pr, key)}</div>
    </div>`;
}

function githubViewSection(title, hint, items, selectedKey, empty, { foldKey = null, open = true } = {}) {
  // While filtering, a section shows only what passes, and opens when something
  // does, unless you folded or unfolded it yourself since the filter changed.
  const filter = githubViewFilter();
  if (items && filterActive(filter)) {
    items = items.filter(i => prMatches(i, filter));
    // Merged or closed stays as it was: old PRs only show when you open them.
    if (!githubViewState.foldedByHand.has(foldKey) && foldKey !== 'closed') open = open || items.length > 0;
    empty = 'Nothing matches.';
  }
  const fold = foldKey ? ` ghv-section-h--fold" data-fold="${foldKey}` : '';
  return `<div class="ghv-section"><div class="ghv-section-h${fold}" title="${escapeHtml(hint)}">${foldKey ? `<span class="ghv-fold${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>` : ''}${escapeHtml(title)}<span class="ghv-count">${items ? items.length : ''}</span></div>
    ${items === null || !open ? '' : items.length ? items.map(i => githubViewRow(i, selectedKey)).join('') : `<div class="ghv-empty">${escapeHtml(empty)}</div>`}</div>`;
}

// Each section folds; open or shut is remembered per section. Merged or
// closed starts shut, the open ones open.
function githubViewFoldOpen(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(GITHUB_VIEW_FOLDS_KEY) || '{}');
    return key in saved ? !!saved[key] : key !== 'closed';
  } catch { return key !== 'closed'; }
}

function toggleGithubViewFold(key) {
  // While filtering the section may show open only because it has matches: fold what you see.
  const shown = !!githubViewContent?.querySelector(`[data-fold="${key}"] .ghv-fold:not(.shut)`);
  githubViewState.foldedByHand.add(key);
  try {
    const saved = JSON.parse(localStorage.getItem(GITHUB_VIEW_FOLDS_KEY) || '{}');
    saved[key] = !shown;
    localStorage.setItem(GITHUB_VIEW_FOLDS_KEY, JSON.stringify(saved));
  } catch {}
}

function renderGithubViewList() {
  if (!githubViewContent) return;
  const s = githubViewState;
  const selectedKey = githubTabState(GITHUB_VIEW_PROJECT.id).selection?.itemKey || null;
  const scroll = githubViewContent.scrollTop;
  const typing = document.activeElement?.id === 'ghv-search' ? document.activeElement.selectionStart : null;
  githubViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-head-title">Pull requests</span><span class="ws-flex"></span>
      <span class="gh-muted">${s.loading ? 'Loading…' : s.fetchedAt ? `Updated ${escapeHtml(formatDate(new Date(s.fetchedAt)))}` : ''}</span>
      <button type="button" class="ws-ghost ws-ghost--sm" id="ghv-refresh" title="Fetch the lists again">${PICONS.refresh(12)}</button></div>
    ${githubViewFilterHtml()}
    ${s.error ? `<div class="ghv-empty gh-error">${escapeHtml(s.error)}</div>` : ''}
    ${githubViewSection('Review requested', 'Open pull requests that ask for your review', s.review, selectedKey, 'Nothing waiting for your review.', { foldKey: 'review', open: githubViewFoldOpen('review') })}
    ${githubViewSection('My pull requests', 'Open pull requests you opened', s.mine, selectedKey, 'You have no open pull requests.', { foldKey: 'mine', open: githubViewFoldOpen('mine') })}
    ${githubViewSection('Merged or closed', 'The latest pull requests you opened, or whose review was asked of you or done by you, that are merged or closed', s.closed, selectedKey, 'Nothing merged or closed yet.', { foldKey: 'closed', open: githubViewFoldOpen('closed') })}`;
  githubViewContent.scrollTop = scroll;
  githubViewContent.querySelector('#ghv-refresh').onclick = () => loadGithubView();
  bindGithubViewFilter(typing);
  githubViewContent.querySelectorAll('[data-fold]').forEach(h => {
    h.onclick = () => { toggleGithubViewFold(h.dataset.fold); renderGithubViewList(); };
  });
  githubViewContent.querySelectorAll('.ghv-row').forEach(row => {
    row.onclick = () => openGithubViewItem(row.dataset.item, null);
  });
  githubViewContent.querySelectorAll('.gh-pr[data-pr]').forEach(chip => {
    chip.onclick = (e) => { e.stopPropagation(); openGithubViewItem(chip.dataset.item, chip.dataset.pr); };
  });
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

/** The search box and the filters above the lists, offering only what the lists hold. */
function githubViewFilterHtml() {
  const f = githubViewFilter();
  const items = githubViewItems();
  const option = (value, label, current) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const products = [...new Set(items.flatMap(prProducts))].sort((a, b) => (PRODUCT_LABELS[a] || a).localeCompare(PRODUCT_LABELS[b] || b));
  const repos = [...new Set(items.filter(i => !f.product || prProducts(i).includes(f.product)).map(i => i.repo))].sort();
  const plans = new Map();
  for (const p of githubViewState.maps || []) plans.set(p.key, p);
  for (const i of items) for (const p of prPlans(i)) plans.set(p.key, p);
  const planList = [...plans.values()].sort((a, b) => a.title.localeCompare(b.title));
  return `<div class="ghv-filter">
      <div class="ghv-search"><input type="search" id="ghv-search" class="ws-input" placeholder="Search title, #, repo, author, plan…" value="${escapeHtml(f.q)}" spellcheck="false">
        ${filterActive(f) ? '<button type="button" class="ws-ghost ws-ghost--sm" id="ghv-filter-clear" title="Clear the search and filters">×</button>' : ''}</div>
      <div class="ghv-selects">
        <select id="ghv-product" class="gfv-select" title="Product">${option('', 'All products', f.product)}${products.map(p => option(p, PRODUCT_LABELS[p] || p, f.product)).join('')}</select>
        <select id="ghv-repo" class="gfv-select" title="Repository">${option('', 'All repos', f.repo)}${repos.map(r => option(r, githubRepoName(r), f.repo)).join('')}</select>
        <select id="ghv-plan" class="gfv-select" title="Plan: the pitch or wayfinder map the PR's issue belongs to">${option('', 'All plans', f.plan)}${planList.map(p => option(p.key, p.title, f.plan)).join('')}</select>
      </div>
      <div class="ghv-types">${PR_TYPES.map(t => `<button type="button" class="ghv-type-btn ghv-type--${t}${f.types.includes(t) ? ' on' : ''}" data-type="${t}" title="${escapeHtml(PR_TYPE_LABELS[t])}" aria-label="${escapeHtml(PR_TYPE_LABELS[t])}">${prTypeIcon(t, 13)}</button>`).join('')}</div>
    </div>`;
}

function bindGithubViewFilter(caret) {
  const search = githubViewContent.querySelector('#ghv-search');
  if (!search) return;
  if (caret != null) { search.focus(); search.setSelectionRange(caret, caret); }
  search.oninput = () => setGithubViewFilter({ q: search.value });
  search.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); setGithubViewFilter({ q: '' }); } };
  githubViewContent.querySelector('#ghv-product').onchange = (e) => setGithubViewFilter({ product: e.target.value });
  githubViewContent.querySelector('#ghv-repo').onchange = (e) => setGithubViewFilter({ repo: e.target.value });
  githubViewContent.querySelector('#ghv-plan').onchange = (e) => setGithubViewFilter({ plan: e.target.value });
  githubViewContent.querySelectorAll('[data-type]').forEach(b => {
    b.onclick = () => {
      const types = githubViewFilter().types;
      setGithubViewFilter({ types: types.includes(b.dataset.type) ? types.filter(t => t !== b.dataset.type) : [...types, b.dataset.type] });
    };
  });
  const clear = githubViewContent.querySelector('#ghv-filter-clear');
  if (clear) clear.onclick = () => setGithubViewFilter({ q: '', product: '', repo: '', plan: '', types: [] });
}

function openGithubViewItem(itemKey, prKey) {
  // The session beside the panel goes when another PR is picked; it stays for its own PR.
  if ((mainEl.classList.contains('ghv-split') || mainEl.classList.contains('pr-walk')) && activeSessionId && typeof sessionContexts === 'function') {
    const own = sessionContexts(activeSessionId).filter(c => c.kind === 'pr').map(c => c.key);
    if (!own.includes(String(prKey || itemKey).toLowerCase())) leaveSessionSplit();
  }
  const state = githubTabState(GITHUB_VIEW_PROJECT.id);
  state.review = null;
  renderGithubViewMain();
  selectGithubItem(GITHUB_VIEW_PROJECT, itemKey, prKey);
  renderGithubViewList();
}

/** The main area: the PR panel on its own, or a PR's file review. */
function renderGithubViewMain() {
  if (!githubViewer) return;
  const state = githubTabState(GITHUB_VIEW_PROJECT.id);
  if (!githubViewer.querySelector('#ws-body')) githubViewer.innerHTML = '<div class="ws-body" id="ws-body"></div>';
  const body = githubViewer.querySelector('#ws-body');
  if (state.review) { paintGithubReview(GITHUB_VIEW_PROJECT); return; }
  body.className = 'ws-body gh-tab-body';
  body.innerHTML = '<div class="gh-split gh-split--solo has-panel"><aside class="gh-panel" id="gh-panel"></aside></div>';
  paintGithubPanel(GITHUB_VIEW_PROJECT, { resetScroll: true });
}

/** Called when the GitHub tab is opened (app.js). */
function showGithubView() {
  hideAllViewers();
  // hideAllViewers puts the terminal area back; this tab covers it instead.
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  githubViewer.style.display = 'flex';
  renderGithubViewList();
  renderGithubViewMain();
  const stale = !githubViewState.fetchedAt || Date.now() - Date.parse(githubViewState.fetchedAt) > GITHUB_VIEW_REFRESH_MS;
  if (stale) loadGithubView({ quiet: !!githubViewState.fetchedAt });
  else if (githubTabState(GITHUB_VIEW_PROJECT.id).selection) loadGithubDetail(GITHUB_VIEW_PROJECT, { quiet: true });
  clearInterval(githubViewState.timer);
  githubViewState.timer = setInterval(() => {
    if (activeTab !== 'github') { clearInterval(githubViewState.timer); githubViewState.timer = null; return; }
    loadGithubView({ quiet: true });
  }, GITHUB_VIEW_REFRESH_MS);
}

function hideGithubView() {
  if (githubViewer) githubViewer.style.display = 'none';
  // showSession passes through here too; onSessionSplitShown puts the split back.
  mainEl.classList.remove('ghv-split', 'pr-walk', 'pr-walk--brief');
}
