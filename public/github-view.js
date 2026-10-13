// --- GitHub tab: your pull requests and the ones waiting for your review ---
// The sidebar lists both, read live from GitHub; picking one shows the same
// PR panel the projects' Plan tab has (merge, checks, reviews, Claude
// sessions, Files changed). It runs as the pseudo-project GITHUB_VIEW_PROJECT
// in its own viewer (#github-viewer), so that code needs no second copy.
// Depends on: project-github-view.js (GITHUB_VIEW_PROJECT, githubTabState,
// githubPrChip, githubItemKey, selectGithubItem, paintGithubPanel,
// renderProjectGithubTab), utils.js (escapeHtml, formatDate), PICONS.

const githubViewContent = document.getElementById('github-content');
const githubViewer = document.getElementById('github-viewer');
const GITHUB_VIEW_REFRESH_MS = 2 * 60 * 1000;

const githubViewState = { mine: null, review: null, error: null, loading: false, fetchedAt: null, timer: null };

function githubViewItems() {
  return [...(githubViewState.mine || []), ...(githubViewState.review || [])];
}

/** Put the lists where the PR panel finds its items (findGithubItem). */
function syncGithubViewResults() {
  const state = githubTabState(GITHUB_VIEW_PROJECT.id);
  state.results = new Map([['github-view', { items: githubViewItems() }]]);
}

async function loadGithubView({ quiet = false } = {}) {
  if (githubViewState.loading) return;
  githubViewState.loading = true;
  if (!quiet) renderGithubViewList();
  const result = await window.api.getMyGithubPullRequests().catch(err => ({ error: err?.message || String(err) }));
  githubViewState.loading = false;
  if (result?.error) githubViewState.error = result.error;
  else {
    githubViewState.error = null;
    githubViewState.mine = result.mine || [];
    githubViewState.review = result.review || [];
    githubViewState.fetchedAt = result.fetchedAt;
    syncGithubViewResults();
  }
  renderGithubViewList();
  // A PR on screen is refreshed with the list.
  if (activeTab === 'github' && !githubTabState(GITHUB_VIEW_PROJECT.id).review) paintGithubPanel(GITHUB_VIEW_PROJECT);
}

function githubViewRow(item, selectedKey) {
  const key = githubItemKey(item);
  const pr = item.pullRequests[0];
  return `<div class="ghv-row${key === selectedKey ? ' selected' : ''}" data-item="${escapeHtml(key)}" title="${escapeHtml(`${item.repo}#${item.number}: ${item.title}`)}">
      <div class="ghv-row-title">${escapeHtml(item.title)}</div>
      <div class="ghv-row-meta"><span class="ghv-row-ref">${escapeHtml(githubRepoName(item.repo))}#${item.number}</span>
        ${item.author && item.author !== 'ghost' ? `<span class="ghv-row-author">${escapeHtml(item.author)}</span>` : ''}
        <span class="ws-flex"></span>${githubPrChip(pr, key)}</div>
    </div>`;
}

function githubViewSection(title, hint, items, selectedKey, empty) {
  return `<div class="ghv-section"><div class="ghv-section-h" title="${escapeHtml(hint)}">${escapeHtml(title)}<span class="ghv-count">${items ? items.length : ''}</span></div>
    ${items === null ? '' : items.length ? items.map(i => githubViewRow(i, selectedKey)).join('') : `<div class="ghv-empty">${escapeHtml(empty)}</div>`}</div>`;
}

function renderGithubViewList() {
  if (!githubViewContent) return;
  const s = githubViewState;
  const selectedKey = githubTabState(GITHUB_VIEW_PROJECT.id).selection?.itemKey || null;
  const scroll = githubViewContent.scrollTop;
  githubViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-head-title">Pull requests</span><span class="ws-flex"></span>
      <span class="gh-muted">${s.loading ? 'Loading…' : s.fetchedAt ? `Updated ${escapeHtml(formatDate(new Date(s.fetchedAt)))}` : ''}</span>
      <button type="button" class="ws-ghost ws-ghost--sm" id="ghv-refresh" title="Fetch the lists again">${PICONS.refresh(12)}</button></div>
    ${s.error ? `<div class="ghv-empty gh-error">${escapeHtml(s.error)}</div>` : ''}
    ${githubViewSection('Review requested', 'Open pull requests that ask for your review', s.review, selectedKey, 'Nothing waiting for your review.')}
    ${githubViewSection('My pull requests', 'Open pull requests you opened', s.mine, selectedKey, 'You have no open pull requests.')}`;
  githubViewContent.scrollTop = scroll;
  githubViewContent.querySelector('#ghv-refresh').onclick = () => loadGithubView();
  githubViewContent.querySelectorAll('.ghv-row').forEach(row => {
    row.onclick = () => openGithubViewItem(row.dataset.item, null);
  });
  githubViewContent.querySelectorAll('.gh-pr[data-pr]').forEach(chip => {
    chip.onclick = (e) => { e.stopPropagation(); openGithubViewItem(chip.dataset.item, chip.dataset.pr); };
  });
}

function openGithubViewItem(itemKey, prKey) {
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
}
