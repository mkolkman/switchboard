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
