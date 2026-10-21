const test = require('node:test');
const assert = require('node:assert/strict');

const { prType, prProducts, prPlans, prMatches, filterActive } = require('../public/github-pr-filter');

const pr = (over = {}) => ({ repo: 'MoveLab-Studio/WATERROWER-NOHRD-Connect', number: 1, title: 'Show the debrief', author: 'nhaarman', branch: 'wrc-debrief', labels: [], issues: [], ...over });
const issue = (over = {}) => ({ number: 10, title: 'Debrief screen', url: 'i', type: null, labels: [], parent: null, ...over });

test('prType: the issue decides first, then the PR, else a feature', () => {
  assert.equal(prType(pr({ issues: [issue({ labels: ['severity:high'] })] })).type, 'security');
  assert.equal(prType(pr({ issues: [issue({ labels: ['type:broken'] })] })).type, 'bugfix');
  assert.equal(prType(pr({ issues: [issue({ type: 'Bug' })] })).type, 'bugfix');
  assert.equal(prType(pr({ issues: [issue({ type: 'Feature' })], title: 'Fix the debrief' })).type, 'feature');
  assert.equal(prType(pr({ title: 'Stop returning integration secrets from the admin API' })).type, 'security');
  assert.equal(prType(pr({ branch: 'fix/public-competitor-exposure', title: 'Give competitors a public type' })).type, 'security');
  assert.equal(prType(pr({ title: '[Infra] Bump the snapshot CLI to 1.1.0' })).type, 'upkeep');
  assert.equal(prType(pr({ author: 'dependabot[bot]', title: 'Update guzzle' })).type, 'upkeep');
  assert.equal(prType(pr({ branch: 'fix/deadlock', title: 'Retry a replace that loses a deadlock' })).type, 'bugfix');
  assert.equal(prType(pr({ title: '[NCA] Fix crash in landscape bike registration' })).type, 'bugfix');
  // A skill named fix-something is not a fix by its name alone.
  assert.equal(prType(pr({ title: 'fix-crashlytics: start every agent as a new session', branch: 'agent-session-context' })).type, 'feature');
  assert.equal(prType(pr()).type, 'feature');
  assert.match(prType(pr({ branch: 'fix/x' })).reason, /branch/);
});

test('prType: a type label on the PR itself wins over its issue and its title', () => {
  assert.deepEqual(prType(pr({ labels: ['enhancement'], issues: [issue({ labels: ['severity:high'] })] })), { type: 'feature', reason: 'its label enhancement' });
  assert.equal(prType(pr({ labels: ['type:maintenance'], title: 'Fix the debrief' })).type, 'upkeep');
  assert.equal(prType(pr({ labels: ['Documentation'] })).type, 'documentation');
  // Labels that are not a type's leave the guessing as it was.
  assert.equal(prType(pr({ labels: ['autorebase:opt-in'], title: 'Fix the debrief' })).type, 'bugfix');
});

test('prType: documentation by its issue label, its title or its branch', () => {
  assert.equal(prType(pr({ issues: [issue({ labels: ['documentation'] })] })).type, 'documentation');
  assert.equal(prType(pr({ title: '[Docs] Explain the release flow' })).type, 'documentation');
  assert.equal(prType(pr({ title: 'Docs: describe the metrics endpoint' })).type, 'documentation');
  assert.equal(prType(pr({ title: 'Update the README for the new setup' })).type, 'documentation');
  assert.equal(prType(pr({ branch: 'docs/release-flow', title: 'Release flow' })).type, 'documentation');
  assert.equal(prType(pr({ title: 'Show the documents list' })).type, 'feature');
});

test('prProducts: a shared repo by its title prefixes, else all it serves; other repos none', () => {
  assert.deepEqual(prProducts(pr({ title: '[WRA] Filter duplicate entries' })), ['waterrower']);
  assert.deepEqual(prProducts(pr({ title: '[NCI] Show the heart rate' })), ['nohrd']);
  assert.deepEqual(prProducts(pr({ title: '[Infra] Use the shared snapshot CLI' })), ['nohrd', 'waterrower']);
  assert.deepEqual(prProducts(pr({ repo: 'MoveLab-Studio/MoveLab-Connect-Web', title: '[CityRow→WNA] M15b Migration command' })), ['cityrow']);
  assert.deepEqual(prProducts(pr({ repo: 'MoveLab-Studio/RP3-App' })), ['rp3']);
  assert.deepEqual(prProducts(pr({ repo: 'MoveLab-Studio/movelab-claude-skills' })), []);
});

test('prPlans: the parents of its issues, once each', () => {
  const map = { number: 3150, title: 'Session Debrief (map)', url: 'https://github.com/MoveLab-Studio/WATERROWER-NOHRD-Connect/issues/3150', repo: 'MoveLab-Studio/WATERROWER-NOHRD-Connect' };
  const plans = prPlans(pr({ issues: [issue({ parent: map }), issue({ number: 11, parent: map }), issue({ number: 12 })] }));
  assert.deepEqual(plans, [{ key: 'MoveLab-Studio/WATERROWER-NOHRD-Connect#3150', number: 3150, title: 'Session Debrief (map)', url: map.url }]);
});

test('prMatches: every word somewhere, and each filter as an and', () => {
  const map = { number: 3150, title: 'Session Debrief', url: 'u', repo: 'MoveLab-Studio/WATERROWER-NOHRD-Connect' };
  const item = pr({ title: '[WRA] Show the debrief chart', issues: [issue({ type: 'Feature', parent: map })] });
  assert.ok(prMatches(item, { q: 'debrief chart' }));
  assert.ok(prMatches(item, { q: '#1' }));
  assert.ok(prMatches(item, { q: 'session' })); // the plan's title
  assert.ok(!prMatches(item, { q: 'debrief nohrd-only' }));
  assert.ok(prMatches(item, { product: 'waterrower', types: ['feature', 'bugfix'], plan: 'MoveLab-Studio/WATERROWER-NOHRD-Connect#3150' }));
  assert.ok(!prMatches(item, { product: 'nohrd' }));
  assert.ok(!prMatches(item, { repo: 'MoveLab-Studio/RP3-App' }));
  assert.ok(!prMatches(item, { types: ['security'] }));
  assert.equal(filterActive({ q: '  ', types: [] }), false);
  assert.equal(filterActive({ types: ['bugfix'] }), true);
});
