const test = require('node:test');
const assert = require('node:assert/strict');

const { disableSleepArgs, parseSleepDisabled } = require('../sleep-control');

const PMSET = (flag) => [
  'System-wide power settings:',
  ` SleepDisabled\t\t${flag}`,
  'Currently in use:',
  ' sleep                1 (sleep prevented by powerd, caffeinate)',
  ' displaysleep         1',
].join('\n');

test('SleepDisabled 1 is sleep disabled, 0 is allowed whatever caffeinate does', () => {
  assert.equal(parseSleepDisabled(PMSET('1')), true);
  assert.equal(parseSleepDisabled(PMSET('0')), false);
});

test('no SleepDisabled line: allowed when it is pmset output (never set), else null', () => {
  assert.equal(parseSleepDisabled('System-wide power settings:\nCurrently in use:\n sleep  1\n'), false);
  assert.equal(parseSleepDisabled(' sleep  1\n displaysleep  10\n'), null);
  assert.equal(parseSleepDisabled(''), null);
});

test('the pmset arguments for each position', () => {
  assert.deepEqual(disableSleepArgs(true), ['disablesleep', '1']);
  assert.deepEqual(disableSleepArgs(false), ['disablesleep', '0']);
});
