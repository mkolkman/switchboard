const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/utils.js is a renderer script that reads SessionConfig as it loads.
const context = vm.createContext({ SessionConfig: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/utils.js'), 'utf8'), context);
const fuzzyMatch = (query, text) => JSON.parse(JSON.stringify(vm.runInContext('fuzzyMatch', context)(query, text)));

// Rank a list of candidates the way the project picker does: best score first.
function rank(query, candidates) {
  return candidates
    .map(text => ({ text, match: fuzzyMatch(query, text) }))
    .filter(c => c.match)
    .sort((a, b) => b.match.score - a.match.score)
    .map(c => c.text);
}

test('matches characters in order, not just substrings', () => {
  assert.ok(fuzzyMatch('swb', 'switchboard'));
  assert.ok(fuzzyMatch('jbsw', 'JBlaak/switchboard'));
  // Out of order is not a match.
  assert.equal(fuzzyMatch('bws', 'switchboard'), null);
  // A character that isn't there at all is not a match.
  assert.equal(fuzzyMatch('swbz', 'switchboard'), null);
});

test('matching is case-insensitive', () => {
  assert.ok(fuzzyMatch('SWB', 'switchboard'));
  assert.ok(fuzzyMatch('jb', 'JBlaak/switchboard'));
});

test('an empty query matches everything at score 0', () => {
  assert.deepEqual(fuzzyMatch('', 'switchboard'), { score: 0, positions: [] });
});

test('positions point at the matched characters', () => {
  assert.deepEqual(fuzzyMatch('swb', 'switchboard').positions, [0, 1, 6]);
});

test('a contiguous run beats scattered characters', () => {
  // "board" is contiguous in the first, scattered in the second.
  assert.deepEqual(rank('board', ['me/switchboard', 'b-o-a-r-d-x']), ['me/switchboard', 'b-o-a-r-d-x']);
});

test('a later contiguous run wins over an earlier scattered one', () => {
  // The greedy first pass would settle for a[0] + b[3]; restarting finds "ab".
  assert.deepEqual(fuzzyMatch('ab', 'a-ab').positions, [2, 3]);
});

test('word boundaries rank above mid-word matches', () => {
  // "sp" as two segment initials beats the same letters buried in one word.
  assert.deepEqual(rank('sp', ['switchboard/public', 'inspector']), ['switchboard/public', 'inspector']);
});

test('camelCase humps count as word boundaries', () => {
  // 'l' lands on the hump in moveLab, mid-word in malformed.
  assert.deepEqual(rank('ml', ['malformed', 'moveLab']), ['moveLab', 'malformed']);
});

test('the match anchor outweighs a boundary mid-match', () => {
  // Both are label-style strings; "sb" should anchor on switchboard rather than
  // on the s of joris just because its b follows a separator.
  assert.deepEqual(rank('sb', ['joris@build-box/deploy', 'JBlaak/switchboard']),
    ['JBlaak/switchboard', 'joris@build-box/deploy']);
});

test('an early match ranks above a late one', () => {
  assert.deepEqual(rank('lab', ['lab/api', 'work/some/deep/nested/lab']), ['lab/api', 'work/some/deep/nested/lab']);
});

test('no text is never a match', () => {
  assert.equal(fuzzyMatch('a', ''), null);
  assert.equal(fuzzyMatch('a', null), null);
});
