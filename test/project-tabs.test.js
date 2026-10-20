const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The real tab bookkeeping from projects-view.js, without the DOM around it.
const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const tabs = source.slice(source.indexOf('// A project opens on its Plan tab'), source.indexOf('function rememberProjectOverview('));

function setup() {
  const context = vm.createContext({ projectsUi: { selectedProjectId: null, navigationByProject: new Map() } });
  vm.runInContext(tabs, context);
  return context;
}

test('a project opens on its Plan tab', () => {
  const c = setup();
  assert.equal(c.projectTab('one'), 'plan');
});

test('each project remembers the tab it was left on', () => {
  const c = setup();
  c.setProjectTab('one', 'sessions');
  c.setProjectTab('two', 'settings');
  assert.equal(c.projectTab('one'), 'sessions');
  assert.equal(c.projectTab('two'), 'settings');
  assert.equal(c.projectTab('three'), 'plan');
});

test('the old Overview tab is gone and an unknown tab changes nothing', () => {
  const c = setup();
  c.setProjectTab('one', 'sessions');
  c.setProjectTab('one', 'overview');
  assert.equal(c.projectTab('one'), 'sessions');
  c.setProjectTab('one', 'github');
  assert.equal(c.projectTab('one'), 'plan', 'GitHub lives on the Plan tab');
});
