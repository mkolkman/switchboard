// --- PR review: the files a pull request changes, one diff at a time ---
// Opened from a PR's panel on the Plan tab ("Files changed"). It takes the
// tab's whole body: a bar with the way back to the PR, a tree of the changed
// files, and the selected file's diff with old and new line numbers. The
// files and patches are read live from GitHub, never stored.
// Depends on: project-github-view.js (githubTabState, githubTarget,
// renderProjectGithubTab, githubTabShown), project-git-view.js
// (buildGitChangeTree, gitTreeRows), projects-view.js (PICONS, projectViewer,
// selectedProject, projectTab).

/** Open the review of a PR, in place of the list and panel. */
function openGithubReview(project, prKey, title, focus = null) {
  const state = githubTabState(project.id);
  const same = state.review?.prKey === prKey;
  state.review = same ? state.review : {
    prKey, title: title || '', files: null, error: null, selected: null, collapsed: new Set(),
    headSha: null, comments: [], hl: new Map(), composer: null, wholeFile: false, contents: new Map(),
  };
  // Opened for one review thread: its file, then the thread itself once drawn.
  if (focus?.path) {
    state.review.selected = focus.path;
    state.review.focusUrl = focus.threadUrl || null;
    state.review.focusUntil = null;
  }
  const body = githubRoot(project)?.querySelector('#ws-body');
  if (body) renderProjectGithubTab(project, body);
  if (!state.review.files) loadGithubReviewFiles(project);
}

function closeGithubReview(project) {
  const state = githubTabState(project.id);
  state.review = null;
  const body = githubRoot(project)?.querySelector('#ws-body');
  if (body) renderProjectGithubTab(project, body);
}

async function loadGithubReviewFiles(project) {
  const state = githubTabState(project.id);
  const review = state.review;
  if (!review || review.loading) return;
  review.loading = true;
  review.error = null;
  paintGithubReview(project);
  const target = githubTarget(review.prKey);
  const [result, comments] = await Promise.all([
    window.api.getGithubPullRequestFiles(target).catch(err => ({ error: err?.message || String(err) })),
    window.api.getGithubReviewComments(target).catch(() => null),
  ]);
  review.loading = false;
  if (state.review !== review) return;
  if (result?.error) review.error = result.error;
  else {
    review.files = result.files || [];
    review.headSha = result.headSha || null;
    review.comments = comments?.comments || [];
    review.hl = new Map();
    if (!review.selected || !review.files.some(f => f.path === review.selected)) review.selected = githubReviewOrder(review)[0]?.path || null;
  }
  paintGithubReview(project);
}

async function reloadGithubReviewComments(project) {
  const review = githubTabState(project.id).review;
  if (!review) return;
  const result = await window.api.getGithubReviewComments(githubTarget(review.prKey)).catch(() => null);
  if (githubTabState(project.id).review !== review || !result?.comments) return;
  review.comments = result.comments;
  paintGithubReview(project);
}

// The files in tree order (folders first, natural sort), which is also the
// order Previous and Next walk through, collapsed folders included.
function githubReviewOrder(review) {
  const rows = gitTreeRows(buildGitChangeTree(review.files || []), new Set(), '');
  return rows.filter(r => r.kind === 'file').map(r => r.change);
}

/** A GitHub patch as rows with old and new line numbers. */
function githubPatchRows(patch) {
  let oldLine = 0;
  let newLine = 0;
  const rows = [];
  for (const line of String(patch || '').split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', newNo: newLine++, text: line });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', oldNo: oldLine++, text: line });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line });
    } else {
      rows.push({ kind: 'context', oldNo: oldLine++, newNo: newLine++, text: line });
    }
  }
  return rows;
}

/**
 * The whole new file as diff rows: the patch's rows where it has them, and
 * the file's other lines as context between and around them, numbered on
 * both sides (the old numbers run in step outside the hunks).
 */
function githubWholeFileRows(patch, text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let nextNew = 1;
  let nextOld = 1;
  const fill = (untilNew) => {
    for (; nextNew < untilNew && nextNew <= lines.length; nextNew++, nextOld++) {
      out.push({ kind: 'context', oldNo: nextOld, newNo: nextNew, text: ' ' + lines[nextNew - 1], filler: true });
    }
  };
  for (const row of githubPatchRows(patch)) {
    if (row.kind === 'hunk') {
      const m = row.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { fill(Number(m[2])); nextOld = Number(m[1]); nextNew = Number(m[2]); }
      continue;
    }
    out.push(row);
    if (row.newNo) nextNew = row.newNo + 1;
    if (row.oldNo) nextOld = row.oldNo + 1;
  }
  fill(lines.length + 1);
  return out;
}

/** Fetch a file's text at the PR's head for the whole-file view, once. */
async function loadGithubFileContent(project, review, file) {
  if (review.contents.has(file.path)) return;
  review.contents.set(file.path, { loading: true });
  const result = await window.api.getGithubFileContent(githubTarget(review.prKey), file.path, review.headSha).catch(err => ({ error: err?.message || String(err) }));
  review.contents.set(file.path, result?.error ? { error: result.error } : { text: result.text, hl: null });
  const content = review.contents.get(file.path);
  if (content.text !== undefined && typeof highlightCodeLines === 'function') {
    content.hl = await highlightCodeLines(content.text, file.path).catch(() => null);
  }
  if (githubTabState(project.id).review === review && review.selected === file.path) paintGithubReview(project);
}

// --- Highlighting: per hunk, in the background, kept per file ---

/** Colour a file's hunks; each row of the patch gets its line as HTML. */
async function highlightGithubFile(project, review, file) {
  if (review.hl.has(file.path) || typeof highlightCodeLines !== 'function' || file.patch === null) return;
  review.hl.set(file.path, null); // in progress
  const rows = githubPatchRows(file.patch);
  const html = new Array(rows.length).fill(null);
  let start = 0;
  // A hunk is parsed as one piece, so a string or comment spanning lines stays coloured.
  for (let i = 0; i <= rows.length; i++) {
    if (i < rows.length && rows[i].kind !== 'hunk') continue;
    const block = [];
    for (let j = start; j < i; j++) if (rows[j].kind !== 'meta') block.push(j);
    if (block.length) {
      const lines = await highlightCodeLines(block.map(j => rows[j].text.slice(1)).join('\n'), file.path).catch(() => null);
      if (lines) block.forEach((j, k) => { html[j] = lines[k] ?? null; });
    }
    start = i + 1;
  }
  review.hl.set(file.path, html);
  if (githubTabState(project.id).review === review && review.selected === file.path) paintGithubReview(project);
}

// --- Comments: threads by line, and the composer ---

/** Root comments of a file with their replies, oldest first. */
function githubThreads(review, filePath) {
  const all = (review.comments || []).filter(c => c.path === filePath);
  const roots = all.filter(c => !c.inReplyTo);
  return roots.map(root => ({ root, replies: all.filter(c => c.inReplyTo === root.id) }));
}

const threadKey = (side, line) => `${side}:${line}`;

function githubCommentHtml(c) {
  return `<div class="gh-rc"><div class="gh-rc-h"><span class="gh-who">${escapeHtml(c.author)}</span><span class="ws-flex"></span><a class="gh-muted" href="${escapeHtml(c.url)}">${escapeHtml(githubAgo(c.at))}</a></div><div class="gh-md">${githubMarkdown(c.body)}</div></div>`;
}

function githubComposerHtml(review) {
  const c = review.composer;
  return `<div class="gh-composer">
    <textarea class="ws-input gh-composer-input" rows="3" placeholder="${c.replyTo ? 'Reply…' : `Comment on line ${c.line}…`}">${escapeHtml(c.draft || '')}</textarea>
    ${c.error ? `<div class="gh-error gh-composer-error">${escapeHtml(c.error)}</div>` : ''}
    <div class="gh-composer-acts"><span class="gh-muted">Markdown · ⌘↵ to post · posted to GitHub right away</span><span class="ws-flex"></span>
      <button type="button" class="ws-ghost ws-ghost--sm" data-act="cancel-comment">Cancel</button>
      <button type="button" class="ws-btn ws-btn--primary" data-act="send-comment" ${c.sending ? 'disabled' : ''}>${c.sending ? 'Posting…' : c.replyTo ? 'Reply' : 'Comment'}</button></div>
  </div>`;
}

function githubThreadHtml(review, thread) {
  const replying = review.composer?.replyTo === thread.root.id;
  return `<div class="gh-thread-inline" data-url="${escapeHtml(thread.root.url || '')}">${githubCommentHtml(thread.root)}${thread.replies.map(githubCommentHtml).join('')}
    ${replying ? githubComposerHtml(review) : `<button type="button" class="ws-ghost ws-ghost--sm gh-reply-btn" data-reply="${thread.root.id}">Reply</button>`}</div>`;
}

/**
 * A file's patch as rows with line numbers, colours, threads and the composer.
 * `whole` is the whole file's text and highlighting, for the whole-file view.
 */
function githubDiffHtml(review, file, whole = null) {
  const rows = whole ? githubWholeFileRows(file.patch, whole.text) : githubPatchRows(file.patch);
  const patchHl = review.hl.get(file.path) || null;
  // Whole file: new-side lines take the file's own colours; removed ones the patch's.
  const hl = whole ? rows.map(r => (r.newNo && whole.hl ? whole.hl[r.newNo - 1] ?? null : null)) : patchHl;
  const threads = githubThreads(review, file.path);
  const byKey = new Map();
  for (const t of threads) {
    if (t.root.line === null) continue;
    const key = threadKey(t.root.side, t.root.line);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const placed = new Set();
  const composer = review.composer && !review.composer.replyTo && review.composer.path === file.path ? review.composer : null;
  let html = '';
  rows.forEach((r, i) => {
    const sign = r.kind === 'add' ? '+' : r.kind === 'remove' ? '-' : r.kind === 'context' ? ' ' : '';
    const code = r.kind === 'hunk' || r.kind === 'meta'
      ? escapeHtml(r.text)
      : `<span class="gh-sign">${sign}</span>${hl?.[i] ?? escapeHtml(r.text.slice(1))}`;
    // Removed lines are commented on the old side, the rest on the new one.
    const side = r.kind === 'remove' ? 'LEFT' : 'RIGHT';
    const line = r.kind === 'remove' ? r.oldNo : r.newNo;
    const commentable = (r.kind === 'add' || r.kind === 'remove' || r.kind === 'context') && !!line;
    html += `<div class="gh-diff-row ${r.kind}${r.filler ? ' filler' : ''}">`
      + `<span class="gh-ln">${r.oldNo ?? ''}</span><span class="gh-ln">${r.newNo ?? ''}</span>`
      + `<span class="gh-code">${code || ' '}</span>`
      + (commentable ? `<button type="button" class="gh-add-comment" data-side="${side}" data-line="${line}" title="Comment on this line">+</button>` : '')
      + '</div>';
    const here = [];
    if (commentable) {
      for (const key of [threadKey(side, line), r.kind === 'context' ? threadKey('LEFT', r.oldNo) : null]) {
        if (key && byKey.has(key) && !placed.has(key)) { placed.add(key); here.push(...byKey.get(key)); }
      }
    }
    if (here.length) html += here.map(t => githubThreadHtml(review, t)).join('');
    if (composer && commentable && composer.side === side && composer.line === line) html += githubComposerHtml(review);
  });
  // Comments on lines this diff does not show, or outdated by newer commits.
  const elsewhere = threads.filter(t => t.root.line === null || !placed.has(threadKey(t.root.side, t.root.line)));
  const top = elsewhere.length
    ? `<details class="gh-outdated"${review.outdatedOpen ? ' open' : ''}><summary>${elsewhere.length} comment thread${elsewhere.length === 1 ? '' : 's'} on lines not shown here, or outdated</summary>${elsewhere.map(t =>
      `<div class="gh-muted gh-outdated-at">${t.root.line === null ? `outdated, was line ${t.root.originalLine ?? '?'}` : `line ${t.root.line}`}</div>${githubThreadHtml(review, t)}`).join('')}</details>`
    : '';
  return top + `<div class="gh-diff">${html}</div>`;
}

function githubReviewTreeHtml(review) {
  const rows = gitTreeRows(buildGitChangeTree(review.files || []), review.collapsed, '');
  const code = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
  return rows.map(row => {
    if (row.kind === 'folder') {
      const holdsSelected = row.collapsed && review.selected?.startsWith(`${row.key}/`);
      return `<button type="button" class="git-folder-row${holdsSelected ? ' selected' : ''}" data-folder="${escapeHtml(row.key)}" style="--depth:${row.depth}" aria-expanded="${row.collapsed ? 'false' : 'true'}">
        <span class="git-folder-chevron">${row.collapsed ? PICONS.chevronRight(11) : PICONS.chevronDown(11)}</span>
        <span class="git-folder-icon">${PICONS.folder(13)}</span>
        <span class="git-folder-name mono">${escapeHtml(row.name)}</span>
        <span class="git-folder-count">${row.count}</span></button>`;
    }
    const f = row.change;
    const title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    return `<button type="button" class="git-file-row tree gh-review-file${f.path === review.selected ? ' selected' : ''}" data-path="${escapeHtml(f.path)}" style="--depth:${row.depth}" title="${escapeHtml(title)}">
      <span class="git-file-code ${f.status}">${code[f.status] || 'M'}</span>
      <span class="git-file-path mono">${escapeHtml(row.name)}</span>
      ${(() => { const n = (review.comments || []).filter(c => c.path === f.path).length; return n ? `<span class="gh-review-cc" title="${n} comment${n === 1 ? '' : 's'}">${n}</span>` : ''; })()}
      <span class="gh-review-stat"><span class="gh-plus">+${f.additions}</span> <span class="gh-minus">−${f.deletions}</span></span></button>`;
  }).join('');
}

function githubReviewDiffHtml(review, file) {
  if (!file) return '<div class="git-diff-empty">Select a file to see its changes.</div>';
  const renamed = file.oldPath ? `<span class="gh-muted">${escapeHtml(file.oldPath)} → </span>` : '';
  const head = `<div class="gh-review-file-h"><span class="git-file-code ${file.status}">${{ added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }[file.status] || 'M'}</span>`
    + `<span class="mono gh-review-path">${renamed}${escapeHtml(file.path)}</span>`
    + `<span class="gh-review-stat"><span class="gh-plus">+${file.additions}</span> <span class="gh-minus">−${file.deletions}</span></span>`
    + (file.patch !== null && file.status !== 'deleted' ? `<span class="gh-review-mode">${[['changes', 'Changes', 'Only the changed lines and their context'], ['whole', 'Whole file', 'The whole file, with the changes in place']].map(([mode, label, hint]) =>
      `<button type="button" class="ws-ghost ws-ghost--sm${(mode === 'whole') === !!review.wholeFile ? ' active' : ''}" data-view-mode="${mode}" title="${hint}">${label}</button>`).join('')}</span>` : '')
    + (file.url ? `<button type="button" class="ws-ghost ws-ghost--sm" data-act="file-github" title="Open this file on GitHub">GitHub ↗</button>` : '')
    + '</div>';
  if (file.patch === null) {
    return head + `<div class="git-diff-empty">${file.status === 'renamed' && !file.additions && !file.deletions ? 'Renamed without changes.' : 'GitHub shows no diff for this file (binary or too large). Open it on GitHub to see it.'}</div>`;
  }
  // A deleted file's patch already holds all of it.
  if (!review.wholeFile || file.status === 'deleted') return head + githubDiffHtml(review, file);
  const content = review.contents.get(file.path);
  if (!content || content.loading) return head + '<div class="git-loading"><span class="git-loading-dot"></span>Reading the whole file…</div>';
  if (content.error) return head + `<div class="git-diff-empty">${escapeHtml(content.error)}</div>` + githubDiffHtml(review, file);
  return head + githubDiffHtml(review, file, content);
}

function paintGithubReview(project) {
  const body = githubRoot(project)?.querySelector('#ws-body');
  const state = githubTabState(project.id);
  const review = state.review;
  if (!body || !review || !githubContextVisible(project)) return;
  const files = review.files || [];
  const order = githubReviewOrder(review);
  const index = order.findIndex(f => f.path === review.selected);
  const file = order[index] || null;
  const totals = files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
  const number = review.prKey.split('#')[1];
  // Keep where the reader was in the tree; a new file starts at its top.
  const prevTree = body.querySelector('.gh-review-tree')?.scrollTop || 0;
  const prevDiff = body.querySelector('.gh-review-diff');
  const sameFile = prevDiff?.dataset.path === review.selected;
  const prevDiffScroll = sameFile ? prevDiff.scrollTop : 0;
  const composerFocused = !!body.querySelector('.gh-composer-input')?.matches(':focus');

  body.className = 'ws-body gh-tab-body';
  body.innerHTML = `
    <div class="gh-review-view">
      <div class="gh-review-bar">
        <button type="button" class="ws-btn ws-btn--sm" id="gh-review-back" title="Back to the PR (Esc)">${PICONS.back(13)}<span>PR #${escapeHtml(number)}</span></button>
        <span class="gh-review-title" title="${escapeHtml(review.title)}">${escapeHtml(review.title)}</span>
        ${review.files ? `<span class="gh-muted">${files.length} file${files.length === 1 ? '' : 's'} · <span class="gh-plus">+${totals.add}</span> <span class="gh-minus">−${totals.del}</span></span>` : ''}
        <span class="ws-flex"></span>
        ${order.length ? `<button type="button" class="ws-ghost ws-ghost--sm" id="gh-review-prev" ${index <= 0 ? 'disabled' : ''} title="Previous file (k)">${PICONS.back(11)}</button>
        <span class="gh-muted">${index + 1} / ${order.length}</span>
        <button type="button" class="ws-ghost ws-ghost--sm" id="gh-review-next" ${index >= order.length - 1 ? 'disabled' : ''} title="Next file (j)">${PICONS.chevronRight(11)}</button>` : ''}
        <button type="button" class="ws-ghost ws-ghost--sm" id="gh-review-session" title="A Claude session beside these changes: it reads the PR, then waits for your instruction">${ICONS.claude(12)}<span>Session</span></button>
        <button type="button" class="ws-ghost ws-ghost--sm" id="gh-review-walkthrough" title="A Claude session beside these changes that walks you through the PR step by step (/pr-walkthrough)">${ICONS.claude(12)}<span>Walkthrough</span></button>
        <button type="button" class="ws-ghost ws-ghost--sm" id="gh-review-refresh" title="Fetch the files again">${PICONS.refresh(12)}</button>
      </div>
      ${review.error ? `<div class="git-empty-state"><div class="git-empty-title">Could not read the changes</div><div>${escapeHtml(review.error)}</div></div>`
        : !review.files ? '<div class="git-loading"><span class="git-loading-dot"></span>Reading the changes…</div>'
          : `<div class="gh-review-main">
              <div class="gh-review-tree">${githubReviewTreeHtml(review)}</div>
              <div class="gh-review-diff" data-path="${escapeHtml(review.selected || '')}">${githubReviewDiffHtml(review, file)}</div>
            </div>`}
    </div>`;
  const tree = body.querySelector('.gh-review-tree');
  if (tree) tree.scrollTop = prevTree;
  const diff = body.querySelector('.gh-review-diff');
  if (diff) diff.scrollTop = prevDiffScroll;

  const select = (path) => { review.selected = path; paintGithubReview(project); };
  body.querySelector('#gh-review-back').onclick = () => closeGithubReview(project);
  // Started here, the session opens beside the changes (session-context.js).
  body.querySelector('#gh-review-session').onclick = () => startPrSessionByKey(project, review.prKey, 'context');
  body.querySelector('#gh-review-walkthrough').onclick = () => startPrSessionByKey(project, review.prKey, 'walkthrough');
  body.querySelector('#gh-review-refresh').onclick = () => { review.files = null; review.contents = new Map(); loadGithubReviewFiles(project); };
  const prev = body.querySelector('#gh-review-prev');
  if (prev) prev.onclick = () => order[index - 1] && select(order[index - 1].path);
  const next = body.querySelector('#gh-review-next');
  if (next) next.onclick = () => order[index + 1] && select(order[index + 1].path);
  body.querySelectorAll('.gh-review-file').forEach(btn => { btn.onclick = () => select(btn.dataset.path); });
  body.querySelectorAll('[data-folder]').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.folder;
      if (review.collapsed.has(key)) review.collapsed.delete(key); else review.collapsed.add(key);
      paintGithubReview(project);
    };
  });
  const fileGithub = body.querySelector('[data-act="file-github"]');
  if (fileGithub && file?.url) fileGithub.onclick = () => window.api.openExternal(file.url);
  // The outdated fold stays as it was left across a redraw.
  body.querySelector('.gh-outdated')?.addEventListener('toggle', (e) => { review.outdatedOpen = e.target.open; });
  body.querySelectorAll('[data-view-mode]').forEach(btn => {
    btn.onclick = () => { review.wholeFile = btn.dataset.viewMode === 'whole'; paintGithubReview(project); };
  });
  if (file && review.wholeFile && file.patch !== null && file.status !== 'deleted') loadGithubFileContent(project, review, file);
  if (file) highlightGithubFile(project, review, file);
  bindGithubReviewComments(project, review, file, body, composerFocused);
  revealGithubReviewThread(review, body);
}

/** Scroll to the thread the review was opened for, opening the outdated fold it may sit in. */
function revealGithubReviewThread(review, body) {
  if (!review.focusUrl || !review.files) return;
  const thread = [...body.querySelectorAll('.gh-review-diff .gh-thread-inline')].find(el => el.dataset.url === review.focusUrl);
  if (!thread) { review.focusUrl = null; return; }
  const fold = thread.closest('details');
  if (fold) { fold.open = true; review.outdatedOpen = true; }
  // Centred, unless it is taller than the view: then its start, so it reads from the top.
  const view = body.querySelector('.gh-review-diff');
  thread.scrollIntoView({ block: view && thread.offsetHeight > view.clientHeight * 0.8 ? 'start' : 'center' });
  // The colours arrive in a redraw just after: it scrolls back to the
  // thread too, for a moment, and only the first one flashes it.
  if (!review.focusUntil) {
    review.focusUntil = Date.now() + 1500;
    thread.classList.add('gh-thread-inline--focus');
    setTimeout(() => { if (thread.isConnected) thread.classList.remove('gh-thread-inline--focus'); }, 2400);
  }
  if (Date.now() > review.focusUntil) { review.focusUrl = null; review.focusUntil = null; }
}

function bindGithubReviewComments(project, review, file, body, refocus) {
  body.querySelectorAll('.gh-review-diff a[href]').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) window.api.openExternal(a.href); };
  });
  const openComposer = (spec) => {
    review.composer = { path: file.path, draft: '', ...spec };
    paintGithubReview(project);
    body.querySelector('.gh-composer-input')?.focus();
  };
  body.querySelectorAll('.gh-add-comment').forEach(btn => {
    btn.onclick = () => openComposer({ side: btn.dataset.side, line: Number(btn.dataset.line) });
  });
  body.querySelectorAll('[data-reply]').forEach(btn => {
    btn.onclick = () => openComposer({ replyTo: Number(btn.dataset.reply) });
  });
  const input = body.querySelector('.gh-composer-input');
  if (!input || !review.composer) return;
  input.oninput = () => { review.composer.draft = input.value; };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); review.composer = null; paintGithubReview(project); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); body.querySelector('[data-act="send-comment"]')?.click(); }
  };
  if (refocus) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  body.querySelector('[data-act="cancel-comment"]').onclick = () => { review.composer = null; paintGithubReview(project); };
  body.querySelector('[data-act="send-comment"]').onclick = async () => {
    const c = review.composer;
    if (!c || c.sending || !c.draft.trim()) return;
    c.sending = true;
    c.error = null;
    paintGithubReview(project);
    const target = githubTarget(review.prKey);
    const result = c.replyTo
      ? await window.api.replyGithubReviewComment(target, c.replyTo, c.draft)
      : await window.api.createGithubReviewComment(target, { body: c.draft, path: c.path, line: c.line, side: c.side, commitId: review.headSha });
    if (result?.error) { c.sending = false; c.error = result.error; paintGithubReview(project); return; }
    review.composer = null;
    await reloadGithubReviewComments(project);
  };
}

// j / k walk the files, Esc goes back to the PR, while a review is on screen
// and nothing is being typed into.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.closest?.('.xterm'))) return;
  const project = typeof activeTab !== 'undefined' && activeTab === 'github' ? GITHUB_VIEW_PROJECT
    : typeof selectedProject === 'function' ? selectedProject() : null;
  const root = project ? githubRoot(project) : null;
  if (!project || !root?.querySelector('.gh-review-view')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeGithubReview(project); return; }
  const btn = e.key === 'j' ? root.querySelector('#gh-review-next') : e.key === 'k' ? root.querySelector('#gh-review-prev') : null;
  if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
});
