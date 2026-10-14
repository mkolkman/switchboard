const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/sidebar-rail.js looks up its element and starts a timer as it loads.
const context = vm.createContext({ document: { getElementById: () => null }, setInterval: () => 0 });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/sidebar-rail.js'), 'utf8'), context);
const railRepoAbbrev = vm.runInContext('railRepoAbbrev', context);

test('the repositories worked in most have their own short names', () => {
  assert.equal(railRepoAbbrev('MoveLab-Connect-Web'), 'MLC');
  assert.equal(railRepoAbbrev('MoveLab-Connect-App'), 'MLC');
  assert.equal(railRepoAbbrev('NOHRD-Account'), 'NA');
  assert.equal(railRepoAbbrev('NOHRD-Connect'), 'NC');
  assert.equal(railRepoAbbrev('WATERROWER-NOHRD-Connect'), 'WRC');
  assert.equal(railRepoAbbrev('RP3-Rowing-Web'), 'RP3');
});

test('other names get their words\' initials, or a single word its first letters', () => {
  assert.equal(railRepoAbbrev('my-cool_app'), 'MCA');
  assert.equal(railRepoAbbrev('switchboard'), 'SWI');
  assert.equal(railRepoAbbrev(''), '?');
});
