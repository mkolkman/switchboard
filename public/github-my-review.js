// github-my-review.js: your own review of a PR, kept as a comment review.
//
// GitHub does not let you approve your own PR, so "I reviewed this" is a
// comment review left from the PR panel, marked so it is told apart from the
// other comment reviews on your login (automated reviews, thread replies).
// GitHub records the commit it was left on; github-tracker.js counts how many
// of the PR's files differ between that commit and the head (changedFiles),
// so a rebase alone does not undo the review. Loaded by the renderer as a
// classic script and required by main and the tests, like github-phases.js.

(function (root) {
  const REVIEW_MARK = '<!-- switchboard:reviewed -->';

  /** The comment the "Mark reviewed" button leaves. */
  function reviewMarkBody(sha) {
    return `Reviewed at ${String(sha).slice(0, 7)}.\n\n${REVIEW_MARK}`;
  }

  /** Your newest review that says you reviewed it: a mark, or an approval (on someone else's PR). */
  function latestMyReview(reviews) {
    let latest = null;
    for (const r of reviews || []) {
      const kind = r.state === 'APPROVED' ? 'approved' : r.state === 'COMMENTED' && String(r.body || '').includes(REVIEW_MARK) ? 'mark' : null;
      if (!kind || !r.commit?.oid) continue;
      if (!latest || new Date(r.submittedAt) > new Date(latest.at)) latest = { sha: r.commit.oid, at: r.submittedAt, kind };
    }
    return latest;
  }

  /** none, reviewed (at the head, or moved without touching the PR's files), or changed since. */
  function myReviewState(pr) {
    const mine = pr.myReview;
    if (!mine) return 'none';
    if (mine.sha === pr.headOid || mine.changedFiles === 0) return 'reviewed';
    return 'changed';
  }

  // Most urgent first: an issue sits in the group of its most urgent open PR.
  const MY_REVIEW_GROUPS = [
    { id: 'changes', label: 'Changes requested', hint: 'Someone asked for changes' },
    { id: 'needs', label: 'Needs your review', hint: 'You have not marked it reviewed' },
    { id: 'changed', label: 'Changed since your review', hint: 'Its files changed after you marked it reviewed' },
    { id: 'waiting', label: 'Reviewed by you, waiting', hint: 'You reviewed it; waiting for a requested reviewer or an approval' },
    { id: 'ready', label: 'Reviewed and approved', hint: 'You reviewed it and a person approved it' },
    { id: 'draft', label: 'Draft', hint: 'Only draft pull requests are open' },
    { id: 'none', label: 'No open PR', hint: 'No open pull request', collapsed: true },
  ];

  function prReviewGroup(pr) {
    if (pr.isDraft) return 'draft';
    if (pr.humanReview === 'CHANGES_REQUESTED') return 'changes';
    const mine = myReviewState(pr);
    if (mine === 'none') return 'needs';
    if (mine === 'changed') return 'changed';
    return pr.humanReview === 'APPROVED' && !(pr.requested || []).length ? 'ready' : 'waiting';
  }

  /** The MY_REVIEW_GROUPS id of an issue (or a PR item), from its open PRs. */
  function itemReviewGroup(item) {
    const all = item.pullRequests || [];
    const direct = all.filter(p => p.link !== 'mentions');
    const open = (direct.length ? direct : all).filter(p => p.state === 'OPEN');
    if (!open.length) return 'none';
    const order = MY_REVIEW_GROUPS.map(g => g.id);
    return open.map(prReviewGroup).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  }

  const api = { REVIEW_MARK, MY_REVIEW_GROUPS, reviewMarkBody, latestMyReview, myReviewState, prReviewGroup, itemReviewGroup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
