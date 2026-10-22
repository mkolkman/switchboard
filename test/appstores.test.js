const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePlayInstalls, parseAppSessions, decodeReport } = require('../appstores');

test('decodeReport: Play\'s UTF-16 reports and plain UTF-8', () => {
  const text = 'Date,Package Name\n2026-10-20,nohrd.app\n';
  assert.equal(decodeReport(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
  assert.equal(decodeReport(Buffer.from(`﻿${text}`, 'utf8')), text);
});

test('parsePlayInstalls: the latest day, active device installs per version code', () => {
  const csv = [
    'Date,Package Name,App Version Code,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events',
    '2026-10-19,nohrd.app,20410700,1,0,0,500,1,0,300,1,0,0',
    '2026-10-20,nohrd.app,20410700,1,0,0,510,1,0,320,1,0,0',
    '2026-10-20,nohrd.app,20400500,0,0,0,90,0,0,80,0,0,0',
    '2026-10-20,nohrd.app,20390100,0,0,0,4,0,0,0,0,0,0',
  ].join('\n');
  assert.deepEqual(parsePlayInstalls(csv), { date: '2026-10-20', metric: 'installs on active devices', versions: [{ code: 20410700, count: 320 }, { code: 20400500, count: 80 }] });
});

test('parsePlayInstalls: total user installs when Play no longer fills active devices', () => {
  const csv = 'Date,App Version Code,Total User Installs,Active Device Installs\n2026-10-20,20410700,510,\n';
  assert.deepEqual(parsePlayInstalls(csv), { date: '2026-10-20', metric: 'users who have it installed', versions: [{ code: 20410700, count: 510 }] });
});

test('parseAppSessions: unique devices per version on the latest day, over the other dimensions', () => {
  const tsv = [
    'Date\tApp Name\tApp Version\tDevice\tPlatform Version\tSessions\tUnique Devices',
    '2026-10-19\tNOHRD\t2.41.7\tiPhone\tiOS 26\t50\t40',
    '2026-10-20\tNOHRD\t2.41.7\tiPhone\tiOS 26\t60\t45',
    '2026-10-20\tNOHRD\t2.41.7\tiPad\tiOS 26\t8\t5',
    '2026-10-20\tNOHRD\t2.40.5\tiPhone\tiOS 18\t10\t7',
  ].join('\n');
  assert.deepEqual(parseAppSessions(tsv), { date: '2026-10-20', metric: 'devices that used it that day', versions: [{ name: '2.41.7', count: 50 }, { name: '2.40.5', count: 7 }] });
});
