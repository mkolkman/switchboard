const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/github-wayfinder.js'), 'utf8');

/** public/github-wayfinder.js only defines functions and constants at top level. */
function loadContext() {
  const context = vm.createContext({
    githubItemKey: (item) => `${item.repo}#${item.number}`,
  });
  vm.runInContext(source, context);
  return context;
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const ticket = (number, extra = {}) => ({ repo: 'o/app', number, title: `T${number}`, url: `https://github.com/o/app/issues/${number}`, state: 'OPEN', assignees: [], blockedBy: [], labels: ['wayfinder:grilling'], ...extra });

test('the frontier is open, unblocked, unclaimed sub-issues in map order', () => {
  const { wayfinderFrontier } = loadContext();
  const result = {
    wayfinder: { tickets: ['o/app#5', 'o/app#1', 'o/app#2', 'o/app#3', 'o/app#4', 'o/other#9'] },
    items: [
      ticket(1, { state: 'CLOSED' }),
      ticket(2, { assignees: ['someone'] }),
      ticket(3, { blockedBy: [{ number: 2, state: 'OPEN' }] }),
      ticket(4, { blockedBy: [{ number: 1, state: 'CLOSED' }] }),
      ticket(5),
      // Linked in the map's body but not a sub-issue: not a ticket.
      ticket(6),
      { ...ticket(9), repo: 'o/other' },
    ],
  };
  const sorted = wayfinderFrontier(result);
  assert.equal(sorted.next.number, 5);
  assert.deepEqual(plain(sorted.frontier.map(t => t.number)), [5, 4, 9]);
  assert.deepEqual(plain(sorted.claimed.map(t => t.number)), [2]);
  assert.deepEqual(plain(sorted.blocked.map(t => t.number)), [3]);
});

test('an empty frontier has no next ticket', () => {
  const { wayfinderFrontier } = loadContext();
  const sorted = wayfinderFrontier({ wayfinder: { tickets: ['o/app#1'] }, items: [ticket(1, { assignees: ['me'] })] });
  assert.equal(sorted.next, null);
  assert.equal(sorted.claimed.length, 1);
});

test('a ticket shows its type and its question', () => {
  const { wayfinderType, wayfinderQuestion } = loadContext();
  assert.deepEqual(plain(wayfinderType(ticket(1, { labels: ['bug', 'wayfinder:research'] }))), { id: 'research', label: 'Research', mode: 'AFK', hint: 'a research subagent resolves it' });
  assert.equal(wayfinderType(ticket(1, { labels: ['wayfinder:map'] })), null);
  assert.equal(wayfinderQuestion('Part of #1\n\n## Question\n\nWhat does X do?\nAnd Y?\n\n## Notes\nignore'), 'What does X do?\nAnd Y?');
  assert.equal(wayfinderQuestion('No heading here.'), 'No heading here.');
});
