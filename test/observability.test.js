const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRODUCTS, findComponent, parsePromotions, releaseSummary, componentState, currentTargets,
  isChore, prMatchesFiles, prMatchesTargets, riskProductPaths, groupFeatures,
  versionWindow, errorMatchesFiles, prsForError, eventsPerHour,
} = require('../observability');

const BODY = `2.41.8

Promotions:

| Date | Targets | Stage | Risk | Confirmed by | Acceptance | Override |
|---|---|---|---|---|---|---|
| 2026-10-12 | wra | production | HIGH | Niek | yes | rollout |
| 2026-10-13 | wri, wra | production | MEDIUM | Niek | yes | — |
| 2026-10-10 | wri | internal | LOW | Niek | yes | — |

Targets:

| Target | internal | beta | production |
|---|---|---|---|
| wra | ✅ |  | ✅ |
`;

test('parsePromotions: per target the first date it reached each stage', () => {
  assert.deepEqual(parsePromotions(BODY), {
    wra: { production: '2026-10-12' },
    wri: { production: '2026-10-13', internal: '2026-10-10' },
  });
  assert.deepEqual(parsePromotions('no tables here'), {});
});

test('releaseSummary: the Changes line of a tagged release', () => {
  assert.equal(releaseSummary('1.41.20\n\nChanges: CityRow groundwork, API key fix\n\nmore'), 'CityRow groundwork, API key fix');
  assert.equal(releaseSummary(BODY), null);
});

test('currentTargets: the fullest of the last tables and what came after it, not renamed targets', () => {
  const tags = [
    { name: '3.41.3', targets: { android: {}, ios: {} } },
    { name: '3.41.4', targets: { cityrow_android: {}, cityrow_ios: {}, cityrow_max: {} } },
    { name: '3.41.5', targets: { cityrow_android: {} } },
    { name: '3.41.6', targets: null },
  ];
  assert.deepEqual(currentTargets(tags), ['cityrow_android', 'cityrow_ios', 'cityrow_max']);
  assert.deepEqual(currentTargets([{ name: '1', targets: null }]), []);
});

test('componentState: a staged app per target and stage; a tagged backend from its production deployment', () => {
  const t = (name, date, targets = null, promotions = {}) => ({ name, date, url: null, summary: null, targets, promotions });
  const staged = componentState({ targets: ['wra', 'wri'] }, {
    model: 'staged', url: 'u', branch: 'main', production: null, staging: null,
    tags: [
      t('2.41.7', '2026-10-07', { wra: { production: 100 }, nca: { internal: 100 } }),
      t('2.41.8', '2026-10-11', { wra: { internal: 100, production: 50 }, wri: { internal: 100 } }, { wra: { production: '2026-10-12' } }),
      t('2.41.9', '2026-10-15', { nca: { internal: 100 } }),
    ],
  });
  assert.deepEqual(staged.targets, [
    { name: 'wra', stages: { internal: { tag: '2.41.8', date: '2026-10-11', rollout: 100 }, production: { tag: '2.41.8', date: '2026-10-12', rollout: 50 } } },
    { name: 'wri', stages: { internal: { tag: '2.41.8', date: '2026-10-11', rollout: 100 } } },
  ]);
  // Only the tags of these targets, newest first, with the stages they reached.
  assert.deepEqual(staged.tags.map(x => [x.name, x.stages]), [['2.41.8', ['internal', 'production']], ['2.41.7', ['production']]]);

  const tagged = componentState({}, {
    model: 'tagged', url: 'u', branch: 'main',
    production: { ref: { name: '1.41.9' }, createdAt: '2026-10-18T10:00:00Z' },
    staging: { sha: 'abc', createdAt: '2026-10-19T10:00:00Z' },
    tags: [t('1.41.9', '2026-10-18'), t('1.41.10', '2026-10-19')],
  });
  // A tag whose deploy did not succeed is not what runs.
  assert.deepEqual(tagged.targets, [{ name: null, stages: { production: { tag: '1.41.9', date: '2026-10-18T10:00:00Z', rollout: 100 } } }]);
  assert.deepEqual(tagged.staging, { sha: 'abc', date: '2026-10-19T10:00:00Z' });
});

test('isChore: bots, upkeep labels and titles', () => {
  assert.ok(isChore({ title: 'Bump x', author: 'dependabot[bot]' }));
  assert.ok(isChore({ title: '[Infra] Use the shared snapshot CLI' }));
  assert.ok(isChore({ title: 'Update dependency kotlin to v2.1' }));
  assert.ok(isChore({ title: 'Something', labels: ['dependencies'] }));
  assert.ok(!isChore({ title: '[WRA] Filter duplicate entries in rankings list' }));
});

test('prMatchesFiles: a backend\'s part of the code, shared code for both, all without a full file list', () => {
  const only = { only: /(^|\/)water_?rower/i, shared: /^database\/migrations\// };
  const not = { not: /(^|\/)water_?rower/i };
  const wr = { files: ['app/WaterRower/Leaderboard.php'], filesTotal: 1 };
  const nohrd = { files: ['app/Training/Plan.php'], filesTotal: 1 };
  const migration = { files: ['database/migrations/2026_add.php'], filesTotal: 1 };
  assert.ok(prMatchesFiles(wr, only) && !prMatchesFiles(wr, not));
  assert.ok(!prMatchesFiles(nohrd, only) && prMatchesFiles(nohrd, not));
  assert.ok(prMatchesFiles(migration, only) && prMatchesFiles(migration, not));
  assert.ok(prMatchesFiles({ files: ['a'], filesTotal: 150 }, only));
  assert.ok(prMatchesFiles(nohrd, undefined));
});

test('riskProductPaths and prMatchesTargets: a target\'s own files or code no target owns', () => {
  const paths = riskProductPaths(`[risk]
paths = []

[risk.products]
wra = ["waterrower-connect/waterrower-connect-android/"]
nca = [
  "nohrd-connect/nohrd-app-android/",
]

[stages]
order = ["internal"]
`);
  assert.deepEqual(paths, { wra: ['waterrower-connect/waterrower-connect-android/'], nca: ['nohrd-connect/nohrd-app-android/'] });
  const pr = (...files) => ({ files, filesTotal: files.length });
  assert.ok(prMatchesTargets(pr('waterrower-connect/waterrower-connect-android/A.kt'), ['wra', 'wri'], paths));
  assert.ok(!prMatchesTargets(pr('nohrd-connect/nohrd-app-android/A.kt'), ['wra', 'wri'], paths));
  assert.ok(prMatchesTargets(pr('multiplatform/Shared.kt'), ['wra', 'wri'], paths));
  assert.ok(prMatchesTargets(pr('x'), null, paths));
});

test('groupFeatures: per issue under its pitch or map, loose PRs, upkeep apart', () => {
  const map = { number: 3150, title: 'Session Debrief (map)', url: 'm' };
  const issue = (number, parent = null) => ({ number, title: `Issue ${number}`, url: `i${number}`, state: 'CLOSED', parent });
  const prs = [
    { number: 1, title: 'A', issues: [issue(20)] },
    { number: 2, title: 'B', issues: [issue(11, map)] },
    { number: 3, title: 'C', issues: [issue(10, map)] },
    { number: 4, title: 'D', issues: [issue(10, map)] },
    { number: 5, title: 'Loose fix', issues: [] },
    { number: 6, title: 'Bump gradle', issues: [] },
  ];
  const { groups, other, chores } = groupFeatures(prs);
  assert.deepEqual(groups.map(g => [g.parent?.number ?? null, g.issues.map(i => [i.issue.number, i.prs.map(p => p.number)])]), [
    [3150, [[10, [3, 4]], [11, [2]]]],
    [null, [[20, [1]]]],
  ]);
  assert.deepEqual(other.map(p => p.number), [5]);
  assert.deepEqual(chores.map(p => p.number), [6]);
});

test('the registry: unique component ids, NOHRD backends under both products', () => {
  const ids = PRODUCTS.flatMap(p => p.components.map(c => c.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(PRODUCTS.map(p => p.id), ['mlc', 'nohrd', 'waterrower', 'cityrow', 'drwolff', 'rp3']);
  for (const p of PRODUCTS.filter(x => x.owner)) assert.ok(PRODUCTS.some(x => x.id === p.owner), p.id);
  assert.equal(findComponent('waterrower-account').repo, 'NOHRD-Account');
  assert.equal(findComponent('waterrower-account').product, 'waterrower');
  assert.equal(findComponent('nope'), null);
});

test('versionWindow: from the deploy to the next version, and the stretch before it', () => {
  const state = {
    targets: [{ name: null, stages: { production: { tag: '1.41.10', date: '2026-10-19T12:02:44Z' } } }],
    tags: [
      { name: '1.41.11', date: '2026-10-20T09:00:00Z' },
      { name: '1.41.10', date: '2026-10-19T12:00:00Z' },
      { name: '1.41.9', date: '2026-10-15T08:00:00Z' },
    ],
  };
  assert.deepEqual(versionWindow(state, '1.41.10'), {
    since: '2026-10-19T12:02:44Z', until: '2026-10-20T09:00:00Z',
    previous: { since: '2026-10-15T08:00:00Z', until: '2026-10-19T12:02:44Z' },
  });
  assert.deepEqual(versionWindow(state, '1.41.9'), { since: '2026-10-15T08:00:00Z', until: '2026-10-19T12:00:00Z', previous: null });
  assert.equal(versionWindow(state, 'nope'), null);
});

test('errorMatchesFiles: an error belongs to WaterRower by its file or its route', () => {
  const only = { only: /(^|\/)water_?rower/i, shared: /^app\/Models\// };
  const not = { not: /(^|\/)water_?rower/i };
  const wrRoute = { file: 'app/Http/Middleware/AcceptLanguage.php', context: 'GET /api/waterrower/community' };
  const wrFile = { file: 'app/WaterRower/Leaderboard.php', context: 'GET /api/waterrower/leaderboard' };
  const nohrd = { file: 'app/Training/Plan.php', context: 'GET /api/training/enrollments' };
  assert.ok(errorMatchesFiles(wrRoute, only) && errorMatchesFiles(wrRoute, not));
  assert.ok(errorMatchesFiles(wrFile, only) && !errorMatchesFiles(wrFile, not));
  assert.ok(!errorMatchesFiles(nohrd, only) && errorMatchesFiles(nohrd, not));
  assert.ok(errorMatchesFiles({ file: 'app/Models/User.php', context: 'POST /oauth/token' }, only));
  assert.ok(errorMatchesFiles({ file: '', context: '' }, only));
  assert.ok(errorMatchesFiles(nohrd, undefined));
});

test('prsForError: the version\'s PRs that changed the error\'s file', () => {
  const prs = [
    { number: 1, title: 'A', url: 'a', files: ['app/Auth/Token.php', 'x'] },
    { number: 2, title: 'B', url: 'b', files: ['y'] },
  ];
  assert.deepEqual(prsForError({ file: 'app/Auth/Token.php' }, prs), [{ number: 1, title: 'A', url: 'a' }]);
  assert.deepEqual(prsForError({ file: '' }, prs), []);
});

test('eventsPerHour: the events over the span of a trend', () => {
  assert.equal(eventsPerHour([{ from: '2026-10-19T00:00:00Z', to: '2026-10-19T02:00:00Z', events: 10 }, { from: '2026-10-19T02:00:00Z', to: '2026-10-19T04:00:00Z', events: 30 }]), 10);
  assert.equal(eventsPerHour([]), null);
});
