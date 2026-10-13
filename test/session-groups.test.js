const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OTHER_CUSTOMER, sessionStatus, parseCustomerMapping, formatCustomerMapping, customerFor,
  folderBaseName, sortGroupsByActivity, isGroupMode,
} = require('../public/session-groups');

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const DAY = 86400000;

test('sessionStatus puts what needs you ahead of what the process is doing', () => {
  const base = { nowMs: NOW, modifiedMs: NOW, maxAgeDays: 3 };
  assert.equal(sessionStatus({ ...base, attention: true, unread: true, running: true, busy: true }), 'attention');
  assert.equal(sessionStatus({ ...base, unread: true, running: true, busy: true }), 'unread');
  assert.equal(sessionStatus({ ...base, running: true, busy: true }), 'working');
  assert.equal(sessionStatus({ ...base, running: true }), 'idle');
  assert.equal(sessionStatus({ ...base, busy: true }), 'recent', 'busy without a process is leftover state');
});

test('sessionStatus splits stopped sessions on the max age', () => {
  const base = { nowMs: NOW, maxAgeDays: 3 };
  assert.equal(sessionStatus({ ...base, modifiedMs: NOW - 2 * DAY }), 'recent');
  assert.equal(sessionStatus({ ...base, modifiedMs: NOW - 4 * DAY }), 'stale');
  assert.equal(sessionStatus({ ...base, modifiedMs: NaN }), 'stale', 'no timestamp counts as old');
});

test('parseCustomerMapping reads one customer per line', () => {
  const customers = parseCustomerMapping(`
    # comment
    CityRow: CityRow-*, crgo-*
    NOHRD: NOHRD-*,WATERROWER-*

    RP3
    cityrow: CityRow
  `);
  assert.deepEqual(customers, [
    { name: 'CityRow', patterns: ['CityRow-*', 'crgo-*', 'CityRow'] },
    { name: 'NOHRD', patterns: ['NOHRD-*', 'WATERROWER-*'] },
    { name: 'RP3', patterns: ['RP3'] },
  ]);
});

test('formatCustomerMapping round-trips through parseCustomerMapping', () => {
  const customers = [{ name: 'NOHRD', patterns: ['NOHRD-*', 'WATERROWER-*'] }];
  assert.deepEqual(parseCustomerMapping(formatCustomerMapping(customers)), customers);
});

test('customerFor matches repo or folder names, first customer wins', () => {
  const customers = parseCustomerMapping('NOHRD: NOHRD-*, WATERROWER-*\nMoveLab: MoveLab-*, *-SDK\nAll: *');
  assert.equal(customerFor(['WATERROWER-NOHRD-Connect'], customers), 'NOHRD');
  assert.equal(customerFor(['nohrd-account'], customers), 'NOHRD', 'case-insensitive');
  assert.equal(customerFor([null, 'Connections-SDK'], customers), 'MoveLab', 'falls back to the folder name');
  assert.equal(customerFor(['anything'], customers), 'All');
  assert.equal(customerFor(['anything'], parseCustomerMapping('X: x.y')), OTHER_CUSTOMER, 'dots are literal');
  assert.equal(customerFor(['RP3-App'], []), OTHER_CUSTOMER);
});

test('folderBaseName takes the last path segment', () => {
  assert.equal(folderBaseName('/Users/me/Sources/CityRow-App'), 'CityRow-App');
  assert.equal(folderBaseName('/Users/me/Sources/CityRow-App/'), 'CityRow-App');
  assert.equal(folderBaseName('C:\\src\\RP3-App'), 'RP3-App');
});

test('sortGroupsByActivity puts the latest activity first and empty groups last by name', () => {
  const sorted = sortGroupsByActivity([
    { label: 'B', lastActivity: 0 },
    { label: 'Old', lastActivity: 10 },
    { label: 'A', lastActivity: 0 },
    { label: 'New', lastActivity: 20 },
  ]);
  assert.deepEqual(sorted.map(g => g.label), ['New', 'Old', 'A', 'B']);
});

test('isGroupMode accepts only the known modes', () => {
  assert.equal(isGroupMode('customer'), true);
  assert.equal(isGroupMode('bogus'), false);
});
