const test = require('node:test');
const assert = require('node:assert/strict');

const { releaseModel, parseReleaseTargets, resolveRelease } = require('../github-tracker');
const { leastReleased, releaseText } = require('../public/github-releases');

test('releaseModel reads the mls model from release.toml', () => {
  assert.equal(releaseModel('[release]\nname = "X"\nmodel = "tagged"\n'), 'tagged');
  assert.equal(releaseModel('[release]\nmodel = "staged"  # comment'), 'staged');
  assert.equal(releaseModel(''), null);
  assert.equal(releaseModel(null), null);
});

const BODY = `2.41.8

Promotions:

| Date | Targets | Stage | Risk | Confirmed by | Acceptance | Override |
|---|---|---|---|---|---|---|
| 2026-10-12 | wra | production | HIGH | N | yes | rollout |

Targets:

| Target | internal | beta | production |
|---|---|---|---|
| wra | ✅ |  | ✅ 50% |
| nca |  |  |  |
| wri | ✅ |  | ✅ |
| **4 targets** | **2** | **0** | **2** |

<details open>
| Release overall | Breakage |
|---|---|
| 🟡 MEDIUM | MEDIUM |
`;

test('parseReleaseTargets reads the stage each target reached, with rollouts', () => {
  assert.deepEqual(parseReleaseTargets(BODY), {
    wra: { internal: 100, production: 50 },
    nca: {},
    wri: { internal: 100, production: 100 },
  });
  assert.equal(parseReleaseTargets('1.41.19\n\nRisk: MEDIUM\n'), null);
  assert.equal(parseReleaseTargets(null), null);
});

// Tags oldest first, as resolveRelease gets them; `has` lists the tags whose
// commit contains the PR's merge commit.
const tag = (name, date, targets = null) => ({ name, date, targets });
const checker = (has) => {
  const asked = [];
  const check = async (name) => { asked.push(name); return has.includes(name); };
  return { check, asked };
};

test('resolveRelease: a tagged repo is in production from the first tag that contains the merge', async () => {
  const tags = [tag('1.0.0', '2026-10-01T10:00:00Z'), tag('1.0.1', '2026-10-05T10:00:00Z'), tag('1.0.2', '2026-10-07T10:00:00Z')];
  const { check, asked } = checker(['1.0.1', '1.0.2']);
  const got = await resolveRelease({ model: 'tagged', tags }, '2026-10-03T08:00:00Z', check);
  assert.deepEqual(got, { state: 'released', model: 'tagged', stage: 'production', tag: '1.0.1', targets: null });
  assert.ok(!asked.includes('1.0.0'), 'tags older than the merge are never asked');
});

test('resolveRelease: merged after the newest tag, or in no tag yet, is not released', async () => {
  const tags = [tag('1.0.0', '2026-10-01T10:00:00Z')];
  const { check, asked } = checker([]);
  assert.deepEqual(await resolveRelease({ model: 'tagged', tags }, '2026-10-03T08:00:00Z', check),
    { state: 'unreleased', model: 'tagged' });
  assert.deepEqual(asked, []);
  assert.deepEqual(await resolveRelease({ model: 'staged', tags: [tag('1.0.1', '2026-10-04T00:00:00Z')] }, '2026-10-03T08:00:00Z', checker([]).check),
    { state: 'unreleased', model: 'staged' });
});

test('resolveRelease: a repo without tags has no release status', async () => {
  assert.equal(await resolveRelease({ model: null, tags: [] }, '2026-10-03T08:00:00Z', checker([]).check), null);
});

test('resolveRelease: a staged repo shows the furthest stage over every tag that contains the merge', async () => {
  const tags = [
    tag('3.41.2', '2026-09-17T10:00:00Z', { android: { internal: 100 }, ios: { internal: 100 } }),
    tag('3.41.3', '2026-09-28T07:00:00Z', { android: { internal: 100 }, ios: { internal: 100 } }),
    tag('3.41.4', '2026-09-28T09:00:00Z', { android: { internal: 100, production: 100 }, ios: { internal: 100 }, max: { production: 100 } }),
  ];
  const got = await resolveRelease({ model: 'staged', tags }, '2026-09-20T00:00:00Z', checker(['3.41.3', '3.41.4']).check);
  assert.deepEqual(got, {
    state: 'released', model: 'staged', stage: 'production', tag: '3.41.4',
    targets: {
      internal: [{ target: 'android', tag: '3.41.3', rollout: 100 }, { target: 'ios', tag: '3.41.3', rollout: 100 }],
      beta: [],
      production: [{ target: 'android', tag: '3.41.4', rollout: 100 }, { target: 'max', tag: '3.41.4', rollout: 100 }],
    },
  });
});

test('resolveRelease: a later tag that does not contain the merge (a hotfix branch) does not count', async () => {
  const tags = [
    tag('2.41.2', '2026-09-14T10:00:00Z', { wra: { internal: 100 } }),
    tag('2.40.21', '2026-09-15T10:00:00Z', { wra: { internal: 100, production: 100 } }),
  ];
  const got = await resolveRelease({ model: 'staged', tags }, '2026-09-10T00:00:00Z', checker(['2.41.2']).check);
  assert.equal(got.stage, 'internal');
  assert.equal(got.tag, '2.41.2');
  assert.deepEqual(got.targets.production, []);
});

test('resolveRelease: a staged tag without a release table is tagged, stage unknown', async () => {
  const tags = [tag('2.41.3', '2026-09-17T10:00:00Z')];
  const got = await resolveRelease({ model: 'staged', tags }, '2026-09-16T00:00:00Z', checker(['2.41.3']).check);
  assert.deepEqual(got, { state: 'released', model: 'staged', stage: null, tag: '2.41.3', targets: null });
});

test('leastReleased picks the PR that is furthest from production', () => {
  const prod = { state: 'released', model: 'tagged', stage: 'production', tag: '1.0.1' };
  const staging = { state: 'unreleased', model: 'tagged' };
  const internal = { state: 'released', model: 'staged', stage: 'internal', tag: '3.0.0' };
  assert.equal(leastReleased([prod, staging]), staging);
  assert.equal(leastReleased([prod, internal]), internal);
  assert.equal(leastReleased([prod, null]), prod);
  assert.equal(leastReleased([]), null);
});

test('releaseText names the state as the list shows it', () => {
  assert.equal(releaseText({ state: 'unreleased', model: 'tagged' }), 'staging');
  assert.equal(releaseText({ state: 'unreleased', model: 'staged' }), 'not released');
  assert.equal(releaseText({ state: 'unreleased', model: null }), 'not released');
  assert.equal(releaseText({ state: 'released', model: 'tagged', stage: 'production', tag: '1.41.20' }), 'production 1.41.20');
  assert.equal(releaseText({ state: 'released', model: 'staged', stage: 'beta', tag: '3.42.0' }), 'beta 3.42.0');
  assert.equal(releaseText({ state: 'released', model: 'staged', stage: null, tag: '2.41.3' }), 'tagged 2.41.3');
});
