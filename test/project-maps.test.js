const test = require('node:test');
const assert = require('node:assert/strict');

const { planMapSync, projectName } = require('../project-maps');

const map = (repo, number, state = 'OPEN', title = 'A map') => ({ repo, number, state, title, url: '', key: `${repo}#${number}`.toLowerCase() });
const row = (id, ref, status = 'active') => ({ id, name: id, status, githubRefs: JSON.stringify([ref]) });

test('planMapSync: a project for each open map without one, status following the map', () => {
  const maps = [
    map('MoveLab-Studio/WATERROWER-NOHRD-Connect', 3129),
    map('MoveLab-Studio/MoveLab-Connect-Web', 2201),
    map('MoveLab-Studio/MoveLab-Connect-Android', 1632),
    map('MoveLab-Studio/RP3-App', 1372, 'CLOSED'),
    map('MoveLab-Studio/NOHRD-Fixed', 10, 'CLOSED'),
  ];
  const rows = [
    row('debrief', 'MoveLab-Studio/WATERROWER-NOHRD-Connect#3129'),
    row('cityrow', 'https://github.com/MoveLab-Studio/MoveLab-Connect-Web/issues/2201'),
    row('racing', 'MoveLab-Studio/RP3-App#1372', 'active'),
    row('loose', 'MoveLab-Studio/Other#1'),
  ];
  const plan = planMapSync(maps, rows);
  // The two linked maps are recognised (also by URL), so only the third open map gets a project.
  assert.deepEqual(plan.create.map(m => m.key), ['movelab-studio/movelab-connect-android#1632']);
  // A closed map's project is done; a closed map without one is left alone.
  assert.deepEqual(plan.status, [{ id: 'racing', name: 'racing', status: 'done' }]);
  // A reopened map's project is active again.
  assert.deepEqual(planMapSync([map('MoveLab-Studio/RP3-App', 1372)], [row('racing', 'MoveLab-Studio/RP3-App#1372', 'done')]).status, [{ id: 'racing', name: 'racing', status: 'active' }]);
});

test('projectName: a map title without its map markers', () => {
  assert.equal(projectName('[WRC] Show the Session Debrief on the Workout finish screen (wayfinder map)'), '[WRC] Show the Session Debrief on the Workout finish screen');
  assert.equal(projectName('[NC] Explore page overhaul — wayfinder map'), '[NC] Explore page overhaul');
  assert.equal(projectName('Map: RAWMLabs Android v1 with Bubble Pond'), 'RAWMLabs Android v1 with Bubble Pond');
  assert.equal(projectName('Run-Row-Run pilot-ready on two tablets'), 'Run-Row-Run pilot-ready on two tablets');
});
