const test = require('node:test');
const assert = require('node:assert/strict');

const { openBlockers, depEdges, depthColumns, layoutGraph } = require('../public/github-deps');

const R = 'o/r';
const dep = (number, state = 'OPEN', repo = R) => ({ repo, number, title: `#${number}`, url: '', state });
const issue = (number, blockedBy = [], blocking = []) => ({ repo: R, number, blockedBy, blocking });

test('openBlockers leaves out closed blockers', () => {
  assert.deepEqual(openBlockers(issue(3, [dep(1, 'CLOSED'), dep(2)])).map(d => d.number), [2]);
  assert.deepEqual(openBlockers({}), []);
});

test('depEdges joins both sides of a relation once, and keeps blockers outside the plan', () => {
  const items = [issue(1, [], [dep(2)]), issue(2, [dep(1), dep(9, 'OPEN', 'o/other')], [dep(50)])];
  const { edges, outside } = depEdges(items);
  assert.deepEqual(edges, [{ from: 'o/r#1', to: 'o/r#2' }, { from: 'o/other#9', to: 'o/r#2' }]);
  assert.deepEqual([...outside.keys()], ['o/other#9']);
});

test('depthColumns puts each issue one step after its longest chain of blockers', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }];
  assert.deepEqual(depthColumns(['a', 'b', 'c', 'd'], edges).map(c => c.keys), [['a', 'd'], ['b'], ['c']]);
});

test('depthColumns survives a cycle', () => {
  const cols = depthColumns(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
  assert.equal(cols.flatMap(c => c.keys).sort().join(), 'a,b');
});

test('layoutGraph orders cards under their blockers and marks backward edges', () => {
  const columns = [{ id: '1', keys: ['a', 'b'] }, { id: '2', keys: ['x', 'y'] }];
  const edges = [{ from: 'b', to: 'x' }, { from: 'a', to: 'y' }, { from: 'y', to: 'b' }];
  const out = layoutGraph(columns, edges);
  assert.deepEqual(out.columns[1].keys, ['y', 'x']);
  assert.deepEqual(out.edges.map(e => e.back), [false, false, true]);
});
