const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRef, formatRef, linkedIssueRefs, itemStatus, summarize, shapeIssue } = require('../github-tracker');

test('parseRef reads issue URLs, short refs and Project URLs', () => {
  assert.deepEqual(parseRef('https://github.com/MoveLab-Studio/MoveLab-Connect-Web/issues/2201'),
    { kind: 'issue', owner: 'MoveLab-Studio', repo: 'MoveLab-Connect-Web', number: 2201 });
  assert.deepEqual(parseRef(' MoveLab-Studio/NOHRD-Account#1234 '),
    { kind: 'issue', owner: 'MoveLab-Studio', repo: 'NOHRD-Account', number: 1234 });
  assert.deepEqual(parseRef('https://github.com/orgs/MoveLab-Studio/projects/7/views/1'),
    { kind: 'project', ownerType: 'organization', owner: 'MoveLab-Studio', number: 7 });
  assert.deepEqual(parseRef('https://github.com/users/someone/projects/2'),
    { kind: 'project', ownerType: 'user', owner: 'someone', number: 2 });
  assert.equal(parseRef('#12'), null);
  assert.equal(parseRef('https://example.com/a/b/issues/1'), null);
});

test('formatRef gives one canonical text per target', () => {
  assert.equal(formatRef(parseRef('https://github.com/a/b/issues/3#issuecomment-1')), 'a/b#3');
  assert.equal(formatRef(parseRef('https://github.com/orgs/o/projects/7/views/2')), 'https://github.com/orgs/o/projects/7');
});

test('linkedIssueRefs keeps body order, skips duplicates, PRs, ambiguous refs and itself', () => {
  const body = `
| W1 | [W1](https://github.com/o/wna/issues/1) | merged (wna#9) |
| M1 | [M1](https://github.com/o/mlc/issues/5) | PR https://github.com/o/mlc/pull/6 |
See o/app#3 and again https://github.com/o/wna/issues/1, plus #4.
Part of https://github.com/o/mlc/issues/100.`;
  const refs = linkedIssueRefs(body, parseRef('o/mlc#100')).map(formatRef);
  assert.deepEqual(refs, ['o/wna#1', 'o/mlc#5', 'o/app#3']);
});

const pr = (state, extra = {}) => ({ state, isDraft: false, link: 'closes', ...extra });

test('itemStatus follows the issue, then its pull requests', () => {
  assert.equal(itemStatus({ state: 'CLOSED', stateReason: 'COMPLETED', pullRequests: [] }), 'done');
  assert.equal(itemStatus({ state: 'CLOSED', stateReason: 'NOT_PLANNED', pullRequests: [] }), 'dropped');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [] }), 'todo');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('OPEN', { isDraft: true })] }), 'progress');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('MERGED'), pr('OPEN', { isDraft: true })] }), 'merged');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('MERGED'), pr('OPEN')] }), 'review');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('CLOSED')] }), 'todo', 'a closed PR is no progress');
});

test('a PR that only mentions the issue counts when no PR closes or links it', () => {
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('OPEN', { link: 'mentions' })] }), 'review');
  assert.equal(itemStatus({ state: 'OPEN', pullRequests: [pr('OPEN', { link: 'mentions' }), pr('OPEN', { isDraft: true })] }), 'progress');
});

test('shapeIssue merges PRs from every link kind, strongest link wins', () => {
  const p = (number, state = 'OPEN') => ({ __typename: 'PullRequest', number, title: 't', url: 'u', state, isDraft: false, repository: { nameWithOwner: 'o/r' } });
  const issue = shapeIssue({
    number: 1, title: 'x', url: 'u', state: 'OPEN', repository: { nameWithOwner: 'o/r' },
    assignees: { nodes: [{ login: 'mike' }] },
    closedByPullRequestsReferences: { nodes: [p(10, 'MERGED')] },
    timelineItems: { nodes: [
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: p(10, 'MERGED') },
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: p(11) },
      { __typename: 'CrossReferencedEvent', willCloseTarget: false, source: { __typename: 'Issue', number: 5 } },
      { __typename: 'ConnectedEvent', subject: p(12) },
    ] },
  });
  assert.deepEqual(issue.pullRequests.map(x => [x.number, x.link]), [[12, 'linked'], [11, 'mentions'], [10, 'closes']]);
  assert.deepEqual(issue.assignees, ['mike']);
  assert.equal(issue.status, 'review', 'the linked open PR counts, the mention does not');
});

test('summarize leaves dropped items out of the total', () => {
  const s = summarize([{ status: 'done' }, { status: 'todo' }, { status: 'dropped' }]);
  assert.equal(s.total, 2);
  assert.equal(s.done, 1);
  assert.equal(s.counts.dropped, 1);
});

const { humanReview, milestonePlanFromTable, shapeFieldValues } = require('../github-tracker');
const { phasesFrom, unphasedItems, pickPhaseSource, phaseSources } = require('../public/github-phases');

test('humanReview ignores movelabbot and bot accounts', () => {
  const r = (login, state, type = 'User') => ({ state, author: { login, __typename: type } });
  assert.equal(humanReview([r('movelabbot', 'APPROVED')]), null, 'the merge-rights check is not a review');
  assert.equal(humanReview([r('dependabot[bot]', 'APPROVED', 'Bot')]), null);
  assert.equal(humanReview([r('movelabbot', 'APPROVED'), r('JBlaak', 'APPROVED')]), 'APPROVED');
  assert.equal(humanReview([r('JBlaak', 'APPROVED'), r('nhaarman', 'CHANGES_REQUESTED')]), 'CHANGES_REQUESTED');
  assert.equal(humanReview([r('nhaarman', 'COMMENTED')]), null);
});

test('phasesFrom joins milestones by title across repos and orders them', () => {
  const item = (repo, title, status, dueOn = null) => ({ repo, status, milestone: title ? { title, dueOn } : null });
  const phases = phasesFrom([
    item('o/a', 'Cleanup', 'todo'),
    item('o/a', 'Wave 10', 'todo'),
    item('o/b', 'Wave 2', 'done'),
    item('o/a', 'wave 2', 'done'),
    item('o/a', null, 'todo'),
    item('o/b', 'Wave 2', 'dropped'),
  ]);
  assert.deepEqual(phases.map(p => p.title), ['Wave 2', 'Wave 10', 'Cleanup']);
  assert.equal(phases[0].items.length, 3, 'one phase across repos, case-insensitive');
  assert.equal(phases[0].total, 2, 'dropped issues do not count');
  assert.equal(phases[0].complete, true);
  const dated = phasesFrom([item('o/a', 'Late', 'todo', '2027-02-01'), item('o/a', 'Early', 'todo', '2027-01-01'), item('o/a', 'Wave 1', 'todo')]);
  assert.deepEqual(dated.map(p => p.title), ['Early', 'Late', 'Wave 1'], 'due dates first');
});

test('milestonePlanFromTable reads one column of the issue table', () => {
  const body = `
## Issues

| Id | Issue | Wave | State |
|---|---|---|---|
| W1 | [W1 Hasher](https://github.com/o/wna/issues/1) | 0 | merged |
| A6 | [A6 Onboarding \\| prefill](https://github.com/o/app/issues/6) | app release (after M9) | open |
| M23 | [M23 Remove](https://github.com/o/mlc/issues/23) | cleanup (last) | open |
| Ops | no link | 1 | - |
| M9 | [M9](https://github.com/o/mlc/issues/9) | - | open |
`;
  assert.deepEqual(milestonePlanFromTable(body, 'Wave'), [
    { ref: 'o/wna#1', title: 'Wave 0' },
    { ref: 'o/app#6', title: 'App release' },
    { ref: 'o/mlc#23', title: 'Cleanup' },
  ]);
  assert.deepEqual(milestonePlanFromTable(body, 'Nope'), []);
});

const waveDef = {
  name: 'Wave', type: 'single_select',
  options: [{ id: 'o5', name: 'Wave 5', priority: 6 }, { id: 'o0', name: 'Wave 0', priority: 1 }, { id: 'oc', name: 'Cleanup', priority: 7 }, { id: 'o1', name: 'Wave 1', priority: 2 }],
};
const withWave = (repo, wave, status) => ({ repo, status, milestone: null, fields: wave ? { wave: { name: 'Wave', value: wave, optionId: waveDef.options.find(o => o.name === wave)?.id } } : {} });

test('phasesFrom reads a single-select issue field in its option order, empty options included', () => {
  const by = { kind: 'field', key: 'wave', name: 'Wave' };
  const items = [withWave('o/a', 'Wave 1', 'todo'), withWave('o/b', 'Wave 0', 'done'), withWave('o/a', 'Cleanup', 'todo'), withWave('o/a', null, 'todo')];
  const phases = phasesFrom(items, by, waveDef);
  assert.deepEqual(phases.map(p => [p.title, p.items.length]), [['Wave 0', 1], ['Wave 1', 1], ['Wave 5', 0], ['Cleanup', 1]]);
  assert.equal(phases[0].complete, true);
  assert.equal(phases[2].complete, false, 'an empty phase is not done');
  assert.equal(unphasedItems(items, by, waveDef).length, 1);
});

test('pickPhaseSource prefers a saved choice, then a Wave or Phase field, then milestones', () => {
  const source = { issueFields: [{ name: 'Priority', type: 'single_select' }, { name: 'Wave', type: 'single_select' }, { name: 'Start date', type: 'date' }] };
  assert.deepEqual(phaseSources(source).map(s => s.label), ['Priority', 'Wave', 'Milestones'], 'dates cannot hold a phase');
  assert.equal(pickPhaseSource(source, null).name, 'Wave');
  assert.equal(pickPhaseSource(source, { kind: 'field', name: 'priority' }).name, 'Priority', 'a choice saved before keys');
  assert.equal(pickPhaseSource(source, { kind: 'field', key: 'priority' }).name, 'Priority');
  assert.equal(pickPhaseSource(source, { kind: 'field', name: 'Gone' }).name, 'Wave', 'a removed field falls back');
  assert.equal(pickPhaseSource({ issueFields: [] }, null).kind, 'milestone');
});

test('shapeFieldValues keys values by field name', () => {
  const fields = shapeFieldValues([
    { __typename: 'IssueFieldSingleSelectValue', name: 'Wave 2', optionId: 'x', field: { name: 'Wave' } },
    { __typename: 'IssueFieldNumberValue', value: 3, field: { name: 'Points' } },
    { __typename: 'IssueFieldTextValue', value: 'a' },
  ]);
  assert.deepEqual(fields, { wave: { name: 'Wave', value: 'Wave 2', optionId: 'x' }, points: { name: 'Points', value: 3, optionId: null } });
});

test('Project fields are keyed per Project and preferred when named Wave', () => {
  const { shapeProjectValues } = require('../github-tracker');
  const { fields, cards } = shapeProjectValues([{ id: 'item1', project: { id: 'P1' }, fieldValues: { nodes: [
    { __typename: 'ProjectV2ItemFieldTextValue', text: 'M15b title', field: { id: 'F0', name: 'Title' } },
    { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Wave 4', optionId: 'o4', field: { id: 'F1', name: 'Wave' } },
  ] } }]);
  assert.deepEqual(cards, { P1: 'item1' });
  assert.deepEqual(Object.keys(fields), ['P1|F1'], 'Title is not a phase');
  const source = { issueFields: [
    { key: 'P1|F1', name: 'Wave', label: 'Wave (Migration)', type: 'single_select', options: [{ id: 'o3', name: 'Wave 3', priority: 0 }, { id: 'o4', name: 'Wave 4', priority: 1 }] },
    { key: 'P2|F9', name: 'Status', label: 'Status (Other)', type: 'single_select', options: [] },
    { key: 'priority', name: 'Priority', label: 'Priority', type: 'single_select', options: [] },
  ] };
  const by = pickPhaseSource(source, null);
  assert.equal(by.key, 'P1|F1');
  const phases = phasesFrom([{ status: 'todo', fields }], by, source.issueFields[0]);
  assert.deepEqual(phases.map(p => [p.title, p.items.length]), [['Wave 3', 0], ['Wave 4', 1]]);
});

test('planPrTypeLabels: the first of the type\'s labels the repo has, the other types\' off the PR', () => {
  const { planPrTypeLabels } = require('../github-tracker');
  const repo = [{ id: 'L2', name: 'type:correctness' }, { id: 'L3', name: 'type:bugfix' }];
  const onPr = [{ id: 'P1', name: 'enhancement' }, { id: 'P2', name: 'severity:high' }, { id: 'P3', name: 'autorebase:opt-in' }, { id: 'L2', name: 'type:correctness' }];
  assert.deepEqual(planPrTypeLabels('bugfix', repo, onPr), { add: { id: 'L2', name: 'type:correctness' }, remove: [{ id: 'P1', name: 'enhancement' }] });
  // A repo without any: the type's first label, to be made.
  assert.deepEqual(planPrTypeLabels('documentation', [], onPr), { add: { name: 'documentation' }, remove: [{ id: 'P1', name: 'enhancement' }, { id: 'L2', name: 'type:correctness' }] });
});

test('checksSummary: running checks win over a failure so far, which is counted', () => {
  const { checksSummary } = require('../github-tracker');
  const run = (status, conclusion = null) => ({ __typename: 'CheckRun', status, conclusion });
  assert.deepEqual(checksSummary({ state: 'FAILURE', contexts: { nodes: [run('COMPLETED', 'FAILURE'), run('IN_PROGRESS'), run('COMPLETED', 'SUCCESS')] } }), { checks: 'PENDING', checksFailed: 1 });
  assert.deepEqual(checksSummary({ state: 'FAILURE', contexts: { nodes: [run('COMPLETED', 'FAILURE'), run('COMPLETED', 'SKIPPED')] } }), { checks: 'FAILURE', checksFailed: 1 });
  assert.deepEqual(checksSummary({ state: 'SUCCESS', contexts: { nodes: [{ __typename: 'StatusContext', state: 'PENDING' }] } }), { checks: 'PENDING', checksFailed: 0 });
  assert.deepEqual(checksSummary(null), { checks: null, checksFailed: 0 });
});

test('checksSummary: the merge queue\'s automerge status is a place in the queue, not CI', () => {
  const { checksSummary } = require('../github-tracker');
  const run = (status, conclusion = null) => ({ __typename: 'CheckRun', status, conclusion });
  const queue = (state) => ({ __typename: 'StatusContext', context: 'automerge', state });
  assert.deepEqual(checksSummary({ state: 'PENDING', contexts: { nodes: [run('COMPLETED', 'SUCCESS'), queue('PENDING')] } }), { checks: 'SUCCESS', checksFailed: 0 });
  assert.deepEqual(checksSummary({ state: 'FAILURE', contexts: { nodes: [run('COMPLETED', 'SUCCESS'), queue('FAILURE')] } }), { checks: 'SUCCESS', checksFailed: 0 });
  assert.deepEqual(checksSummary({ state: 'PENDING', contexts: { nodes: [run('COMPLETED', 'FAILURE'), queue('PENDING')] } }), { checks: 'FAILURE', checksFailed: 1 });
  assert.deepEqual(checksSummary({ state: 'PENDING', contexts: { nodes: [queue('PENDING')] } }), { checks: null, checksFailed: 0 });
});
