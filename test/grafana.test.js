const test = require('node:test');
const assert = require('node:assert/strict');

const { alertPlatform, alertApps, logQuery, serviceOf, PLATFORMS } = require('../grafana');

test('alerts are told apart by platform and service from their query', () => {
  assert.equal(alertPlatform('rate(mlc_graphql_operation_duration_seconds_count{env="prod"}[15m])'), 'mlc');
  assert.equal(alertPlatform('max by (env) (delta(wnd_orphan_entries[7d]))'), 'nohrd');
  assert.equal(alertPlatform('prometheus_tsdb_storage_blocks_bytes'), null);
  assert.deepEqual(alertApps('wnd_orphan_entries'), ['nohrd-data']);
  assert.deepEqual(alertApps('wna_queue_length + mlc_queue_length'), ['MoveLabConnect', 'nohrd-account']);
});

test('logQuery: the platform\'s apps in prod, the levels, a text it contains; a raw query as it is', () => {
  assert.equal(logQuery({ platform: 'nohrd', levels: ['error', 'warning'] }), '{app=~"nohrd-account|nohrd-data", env="prod", level=~"error|warning"}');
  assert.equal(logQuery({ platform: 'nohrd', app: 'nohrd-data', contains: 'SQLSTATE "40001"' }), '{app=~"nohrd-data", env="prod"} |= "SQLSTATE \\"40001\\""');
  // An app of another platform is ignored, not trusted.
  assert.equal(logQuery({ platform: 'mlc', app: 'rp3' }), '{app=~"MoveLabConnect", env="prod"}');
  assert.equal(logQuery({ platform: 'mlc', raw: '  {app="rp3"} |= "x"  ' }), '{app="rp3"} |= "x"');
  assert.throws(() => logQuery({ platform: 'nope' }), /Unknown platform/);
});

test('every platform names a repo for each of its log apps', () => {
  for (const p of PLATFORMS) for (const app of p.apps) assert.ok(p.repos[app], `${p.id}: ${app}`);
});

test('serviceOf: one service of a platform keeps its own job, app and metric prefix', () => {
  const nohrd = PLATFORMS.find(p => p.id === 'nohrd');
  const data = serviceOf(nohrd, 'nohrd-data');
  assert.deepEqual([data.jobs, data.apps, data.prefix], [['nohrd-data'], ['nohrd-data'], 'wnd']);
  assert.equal(serviceOf(nohrd, ''), nohrd);
  assert.equal(serviceOf(nohrd, 'MoveLabConnect'), nohrd);
});

test('businessQueries: one window back by offset, for the counts', () => {
  const { businessQueries } = require('../grafana');
  const q = businessQueries();
  assert.equal(q['users@7d'], 'sum by (product, kind, window) (business_users{window="7d"} offset 7d)');
  // 30 days back is the edge of Prometheus' retention: the 30-day trend looks 29 days back.
  assert.equal(q['workoutsByType@30d'], 'sum by (product, type, window) (business_workouts{window="30d"} offset 29d)');
  assert.equal(q['strava@7d'], undefined);
});

test('shapeBusiness: per product, now and one window back, app medians only', () => {
  const { shapeBusiness } = require('../grafana');
  const s = (labels, value) => ({ labels, value });
  const products = shapeBusiness({
    users: [s({ product: 'waterrower', kind: 'active', window: '7d' }, 1200), s({ product: 'waterrower', kind: 'accounts', window: 'all' }, 50000)],
    'users@7d': [s({ product: 'waterrower', kind: 'active', window: '7d' }, 1000)],
    workouts: [s({ product: 'waterrower', window: '7d' }, 3000)],
    workoutsByType: [s({ product: 'waterrower', type: 'interval', window: '7d' }, 800)],
    workoutsByChannel: [s({ product: 'nohrd', channel: 'commercial', window: '7d' }, 40)],
    duration: [s({ product: 'waterrower', channel: 'app', type: 'all', window: '7d' }, 1500), s({ product: 'waterrower', channel: 'commercial', type: 'all', window: '7d' }, 600)],
    strava: [s({ product: 'waterrower' }, 4000)],
    training: [s({ product: 'waterrower', kind: 'new_enrollments', window: '7d' }, 30)],
    mrr: [s({ product: 'waterrower' }, 12345)], // business_mrr_euros
  });
  const wr = products.waterrower;
  assert.deepEqual(wr.users.active['7d'], { now: 1200, before: 1000 });
  assert.equal(wr.accounts, 50000);
  assert.deepEqual(wr.workouts.all['7d'], { now: 3000, before: null });
  assert.deepEqual(wr.workouts.types.interval['7d'], { now: 800, before: null });
  assert.equal(wr.duration.all['7d'], 1500);
  assert.equal(wr.strava, 4000);
  assert.equal(wr.training.new_enrollments['7d'], 30);
  assert.equal(wr.mrr, 12345);
  assert.deepEqual(products.nohrd.workouts.channels.commercial['7d'], { now: 40, before: null });
});
