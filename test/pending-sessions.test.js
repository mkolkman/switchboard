const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/utils.js is a renderer script that reads SessionConfig as it loads.
const context = vm.createContext({ SessionConfig: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/utils.js'), 'utf8'), context);
const { isPendingAbandoned, PENDING_GRACE_MS } = vm.runInContext('({ isPendingAbandoned, PENDING_GRACE_MS })', context);

const pending = (extra = {}) => ({ session: { type: 'claude', created: new Date(0).toISOString() }, ...extra });

test('a pending row goes once its process has been gone for the grace period', () => {
  const exitedAt = 1000;
  assert.equal(isPendingAbandoned(pending({ exitedAt }), { now: exitedAt + PENDING_GRACE_MS - 1 }), false);
  assert.equal(isPendingAbandoned(pending({ exitedAt }), { now: exitedAt + PENDING_GRACE_MS + 1 }), true);
});

test('a running, on-screen or terminal row stays', () => {
  const now = PENDING_GRACE_MS * 10;
  assert.equal(isPendingAbandoned(pending({ exitedAt: 1 }), { running: true, now }), false);
  assert.equal(isPendingAbandoned(pending({ exitedAt: 1 }), { onScreen: true, now }), false);
  assert.equal(isPendingAbandoned({ session: { type: 'terminal', created: new Date(0).toISOString() }, exitedAt: 1 }, { now }), false);
});

test('without an exit seen, a row ages from when it was created', () => {
  const created = Date.parse('2026-10-14T10:00:00Z');
  const p = { session: { type: 'claude', created: new Date(created).toISOString() } };
  assert.equal(isPendingAbandoned(p, { now: created + 5000 }), false);
  assert.equal(isPendingAbandoned(p, { now: created + PENDING_GRACE_MS + 1 }), true);
});
