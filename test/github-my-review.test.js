const test = require('node:test');
const assert = require('node:assert/strict');

const { REVIEW_MARK, reviewMarkBody, latestMyReview, myReviewState, itemReviewGroup } = require('../public/github-my-review');

test('reviewMarkBody names the commit and carries the mark', () => {
  const body = reviewMarkBody('81c215b0ee6c15016400e72545f2fb909c408a17');
  assert.match(body, /^Reviewed at 81c215b\./);
  assert.ok(body.includes(REVIEW_MARK));
});

const mark = (sha, at) => ({ state: 'COMMENTED', body: reviewMarkBody(sha), submittedAt: at, commit: { oid: sha } });

test('latestMyReview takes the newest mark or approval, not other comment reviews', () => {
  const reviews = [
    mark('aaa', '2026-10-06T10:00:00Z'),
    { state: 'COMMENTED', body: '> 🤖 **Claude Code** · automated review', submittedAt: '2026-10-07T10:00:00Z', commit: { oid: 'bbb' } },
    { state: 'COMMENTED', body: '', submittedAt: '2026-10-08T10:00:00Z', commit: { oid: 'ccc' } },
  ];
  assert.deepEqual(latestMyReview(reviews), { sha: 'aaa', at: '2026-10-06T10:00:00Z', kind: 'mark' });
  reviews.push({ state: 'APPROVED', body: '', submittedAt: '2026-10-09T10:00:00Z', commit: { oid: 'ddd' } });
  assert.deepEqual(latestMyReview(reviews), { sha: 'ddd', at: '2026-10-09T10:00:00Z', kind: 'approved' });
  assert.equal(latestMyReview([]), null);
  assert.equal(latestMyReview(undefined), null);
});

const open = (extra = {}) => ({ state: 'OPEN', isDraft: false, link: 'closes', headOid: 'head', requested: [], humanReview: null, myReview: null, ...extra });

test('myReviewState: reviewed at the head, or moved without touching the PR\'s files', () => {
  assert.equal(myReviewState(open()), 'none');
  assert.equal(myReviewState(open({ myReview: { sha: 'head' } })), 'reviewed');
  assert.equal(myReviewState(open({ myReview: { sha: 'old', changedFiles: 0 } })), 'reviewed');
  assert.equal(myReviewState(open({ myReview: { sha: 'old', changedFiles: 3 } })), 'changed');
  assert.equal(myReviewState(open({ myReview: { sha: 'old', changedFiles: null } })), 'changed', 'unknown counts as changed');
});

test('itemReviewGroup puts each issue where its most urgent open PR is', () => {
  const item = (...prs) => ({ state: 'OPEN', pullRequests: prs });
  assert.equal(itemReviewGroup(item(open())), 'needs');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'old', changedFiles: 2 } }))), 'changed');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'head' }, requested: ['niek'] }))), 'waiting');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'head' } }))), 'waiting', 'no approval yet');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'head' }, humanReview: 'APPROVED' }))), 'ready');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'head' }, humanReview: 'CHANGES_REQUESTED' }))), 'changes');
  assert.equal(itemReviewGroup(item(open({ myReview: { sha: 'head' }, humanReview: 'APPROVED' }), open())), 'needs');
  assert.equal(itemReviewGroup(item(open({ isDraft: true }))), 'draft');
  assert.equal(itemReviewGroup(item({ state: 'MERGED', link: 'closes' })), 'none');
  assert.equal(itemReviewGroup(item()), 'none');
  // A PR that only mentions the issue counts when there is nothing better.
  assert.equal(itemReviewGroup(item(open({ link: 'mentions' }), { state: 'MERGED', link: 'closes' })), 'none');
  assert.equal(itemReviewGroup(item(open({ link: 'mentions' }))), 'needs');
});

const { reviewCandidates } = require('../github-tracker');

test('reviewCandidates: earlier reviewers to re-request, then suggested, then everyone else', () => {
  const got = reviewCandidates({
    author: 'mkolkman', me: 'mkolkman',
    users: [{ login: 'JBlaak', name: 'Joris' }, { login: 'mkolkman' }, { login: 'movelabbot' }, { login: 'nhaarman', name: 'Niek' }, { login: 'ThomasHaas15' }, { login: 'LvanArkel' }],
    suggested: [{ login: 'ThomasHaas15' }],
    requested: ['nhaarman'],
    reviewed: ['LvanArkel', 'movelabbot'],
  });
  assert.deepEqual(got, [
    { login: 'LvanArkel', name: null, group: 'reviewed' },
    { login: 'ThomasHaas15', name: null, group: 'suggested' },
    { login: 'JBlaak', name: 'Joris', group: 'other' },
  ]);
});
