const { execFile } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// The store apps' installs per version, read for the Production tab:
// Google Play from the monthly installs reports Play Console writes to its
// Cloud Storage bucket (installs on active devices, per version code), the
// App Store from App Store Connect's analytics reports (devices that used
// the app on the latest day, per version). Read-only; the credentials are
// kept in the keychain (service switchboard-play-console, account play: a
// list of { bucket, serviceAccount }; service switchboard-app-store-connect,
// account appstore: { issuerId, keyId, privateKey }) and read through
// /usr/bin/security, as the other tokens are. The one write is starting
// App Store Connect's report collection for an app, and only when asked.

const PLAY = { service: 'switchboard-play-console', account: 'play' };
const APPLE = { service: 'switchboard-app-store-connect', account: 'appstore' };
const ASC_API = 'https://api.appstoreconnect.apple.com/v1';
const CACHE_MS = 6 * 60 * 60 * 1000;

// The store apps by mls target, as their components name them (observability.js).
const STORE_APPS = {
  wra: { store: 'play', id: 'com.label305.waterrower' },
  wri: { store: 'appStore', id: 'com.label305.WaterRower-Monitor' },
  nca: { store: 'play', id: 'nohrd.app' },
  nci: { store: 'appStore', id: 'nohrd.app' },
  cityrow_android: { store: 'play', id: 'com.cityrowgo' },
  cityrow_ios: { store: 'appStore', id: 'com.cityrow.go' },
  'rp3-rowing': { store: 'play', id: 'com.label305.row_perfect' },
  'rp3-racing': { store: 'play', id: 'com.label305.rp3.racing' },
};

function keychainRead({ service, account }) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim() || null);
    });
  });
}

function keychainWrite({ service, account }, value) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], { timeout: 10000 }, (err) => {
      if (err) reject(new Error(`Could not save to the keychain: ${err.message}`));
      else resolve();
    });
  });
}

async function readJson(slot, fallback) {
  const raw = await keychainRead(slot);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const base64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// --- Google Play ---

const playTokens = new Map(); // client_email → { token, until }

/** An access token for a service account, read-only on Cloud Storage. */
async function playToken(sa) {
  const hit = playTokens.get(sa.client_email);
  if (hit && hit.until > Date.now() + 60000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: tokenUri, iat: now, exp: now + 3600,
  }))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) throw new Error(`Google does not accept the service account: ${json?.error_description || json?.error || res.status}`);
  playTokens.set(sa.client_email, { token: json.access_token, until: Date.now() + (json.expires_in || 3600) * 1000 });
  return json.access_token;
}

async function gcs(sa, path) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1${path}`, { headers: { Authorization: `Bearer ${await playToken(sa)}` } });
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 200);
    try { message = JSON.parse(text).error?.message || message; } catch {}
    throw new Error(res.status === 403 ? `The service account may not read this bucket: ${message}` : `Cloud Storage: ${message || res.status}`);
  }
  return res;
}

/** A Play report as text: UTF-16 with a byte order mark, or UTF-8. */
function decodeReport(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/**
 * The latest day of an installs-by-version report: { date, metric,
 * versions: [{ code, count }] }. Installs on active devices when Play still
 * fills that column, else the total user installs.
 */
function parsePlayInstalls(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => line.split(','));
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const date = col('date');
  const code = col('app version code');
  if (date < 0 || code < 0) throw new Error('The Play report has no Date or App Version Code column.');
  const latest = rows.reduce((max, r) => (r[date] > max ? r[date] : max), '');
  const day = rows.filter(r => r[date] === latest);
  for (const [name, metric] of [['active device installs', 'installs on active devices'], ['total user installs', 'users who have it installed']]) {
    const i = col(name);
    if (i < 0) continue;
    const versions = day.map(r => ({ code: Number(r[code]), count: Number(r[i]) || 0 })).filter(v => v.code && v.count > 0);
    if (versions.length) return { date: latest, metric, versions };
  }
  return { date: latest, metric: 'installs', versions: [] };
}

async function playInstalls(packageName) {
  const accounts = await readJson(PLAY, []);
  if (!accounts.length) return { notConnected: true };
  let lastError = null;
  for (const { bucket, serviceAccount } of accounts) {
    try {
      const list = await (await gcs(serviceAccount, `/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(`stats/installs/installs_${packageName}_`)}`)).json();
      const files = (list.items || []).map(i => i.name).filter(n => n.endsWith('_app_version.csv')).sort();
      if (!files.length) continue;
      // Early in a month its report may hold no day yet: the month before then.
      for (const name of files.slice(-2).reverse()) {
        const res = await gcs(serviceAccount, `/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`);
        const report = parsePlayInstalls(decodeReport(Buffer.from(await res.arrayBuffer())));
        if (report.versions.length) return report;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return { error: `No Play account connected here has reports for ${packageName}.` };
}

// --- App Store Connect ---

async function ascToken(key = null) {
  key = key || await readJson(APPLE, null);
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId, typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: key.issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }))}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64url(signature)}`;
}

async function asc(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${ASC_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token || await ascToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try { message = JSON.parse(text).errors?.map(e => e.detail || e.title).join('; ') || message; } catch {}
    throw new Error(res.status === 401 ? 'App Store Connect does not accept the key.' : `App Store Connect: ${message || res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

async function ascApp(bundleId) {
  const apps = await asc(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId,name`);
  const app = (apps?.data || []).find(a => a.attributes?.bundleId === bundleId);
  if (!app) throw new Error(`App Store Connect has no app ${bundleId} for this key.`);
  return app;
}

async function ascReportRequest(appId) {
  const requests = await asc(`/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING`);
  return (requests?.data || []).find(r => !r.attributes?.stoppedDueToInactivity) || null;
}

/**
 * The latest day of an App Sessions report as text columns: unique devices
 * per app version, added up over the report's other dimensions.
 */
function parseAppSessions(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const date = head.indexOf('date');
  const version = head.indexOf('app version');
  const devices = head.indexOf('unique devices');
  if (date < 0 || version < 0 || devices < 0) throw new Error('The App Sessions report has no Date, App Version or Unique Devices column.');
  const latest = rows.reduce((max, r) => (r[date] > max ? r[date] : max), '');
  const byVersion = new Map();
  for (const r of rows) {
    if (r[date] !== latest) continue;
    byVersion.set(r[version], (byVersion.get(r[version]) || 0) + (Number(r[devices]) || 0));
  }
  return { date: latest, metric: 'devices that used it that day', versions: [...byVersion].map(([name, count]) => ({ name, count })).filter(v => v.count > 0) };
}

async function appStoreInstalls(bundleId) {
  const token = await ascToken();
  if (!token) return { notConnected: true };
  const app = await ascApp(bundleId);
  const request = await ascReportRequest(app.id);
  if (!request) return { needsRequest: true, appName: app.attributes?.name || bundleId };
  const reports = await asc(`/analyticsReportRequests/${request.id}/reports?filter[category]=APP_USAGE`, { token });
  const report = (reports?.data || []).find(r => /^app sessions( standard)?$/i.test(r.attributes?.name || ''))
    || (reports?.data || []).find(r => /app sessions/i.test(r.attributes?.name || '') && !/detailed/i.test(r.attributes?.name || ''));
  if (!report) return { waiting: true };
  const instances = await asc(`/analyticsReports/${report.id}/instances?filter[granularity]=DAILY&limit=10`, { token });
  const latest = (instances?.data || []).sort((a, b) => String(b.attributes?.processingDate).localeCompare(String(a.attributes?.processingDate)))[0];
  if (!latest) return { waiting: true };
  const segments = await asc(`/analyticsReportInstances/${latest.id}/segments`, { token });
  let text = '';
  for (const seg of segments?.data || []) {
    const res = await fetch(seg.attributes.url);
    if (!res.ok) throw new Error(`App Store Connect report download failed: ${res.status}`);
    const chunk = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
    text += text ? chunk.slice(chunk.indexOf('\n') + 1) : chunk;
  }
  return parseAppSessions(text);
}

/** Start App Store Connect's daily analytics reports for an app (asked for once; data follows in a day or two). */
async function startAppStoreReports(target) {
  const app = STORE_APPS[target];
  if (app?.store !== 'appStore') throw new Error(`${target} is not an App Store app.`);
  const found = await ascApp(app.id);
  if (await ascReportRequest(found.id)) return { started: false };
  await asc('/analyticsReportRequests', { method: 'POST', body: { data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' }, relationships: { app: { data: { type: 'apps', id: found.id } } } } } });
  cache.delete(target);
  return { started: true };
}

// --- Both ---

const cache = new Map(); // target → { at, promise }

/** Installs per version for the store targets asked: { target: { store, date, metric, versions } | { error } | { notConnected } | ... }. */
async function getInstalls({ targets = Object.keys(STORE_APPS), force = false } = {}) {
  const out = {};
  await Promise.all(targets.filter(t => STORE_APPS[t]).map(async (target) => {
    const app = STORE_APPS[target];
    const hit = cache.get(target);
    if (force || !hit || Date.now() - hit.at > CACHE_MS) {
      const promise = (app.store === 'play' ? playInstalls(app.id) : appStoreInstalls(app.id)).catch(err => { cache.delete(target); throw err; });
      cache.set(target, { at: Date.now(), promise });
    }
    try { out[target] = { store: app.store, ...(await cache.get(target).promise) }; } catch (err) { out[target] = { store: app.store, error: err.message || String(err) }; }
    // Not connected or still waiting is no answer to keep for hours.
    if (out[target].notConnected || out[target].waiting || out[target].needsRequest) cache.delete(target);
  }));
  return { targets: out };
}

/** Which stores are connected (never the keys). */
async function getConfig() {
  const play = await readJson(PLAY, []);
  const apple = await readJson(APPLE, null);
  return {
    play: play.map(a => ({ bucket: a.bucket, account: a.serviceAccount?.client_email || '' })),
    appStore: apple ? { keyId: apple.keyId, issuerId: apple.issuerId } : null,
    targets: Object.fromEntries(Object.entries(STORE_APPS).map(([t, a]) => [t, a.store])),
  };
}

/** Save a Play bucket with its service account, or the App Store Connect key, after checking them. */
async function saveConfig(spec) {
  if (spec.store === 'play') {
    const bucket = String(spec.bucket || '').trim().replace(/^gs:\/\//, '').replace(/\/.*$/, '');
    let serviceAccount;
    try { serviceAccount = JSON.parse(spec.serviceAccount || ''); } catch { throw new Error('Paste the service account\'s whole JSON key file.'); }
    if (!bucket || !serviceAccount?.client_email || !serviceAccount?.private_key) throw new Error('Fill in the bucket and the service account JSON.');
    await gcs(serviceAccount, `/b/${encodeURIComponent(bucket)}/o?prefix=stats/installs/&maxResults=1`);
    const accounts = (await readJson(PLAY, [])).filter(a => a.bucket !== bucket);
    await keychainWrite(PLAY, JSON.stringify([...accounts, { bucket, serviceAccount }]));
  } else if (spec.store === 'appStore') {
    const key = { issuerId: String(spec.issuerId || '').trim(), keyId: String(spec.keyId || '').trim(), privateKey: String(spec.privateKey || '').trim() };
    if (!key.issuerId || !key.keyId || !key.privateKey.includes('PRIVATE KEY')) throw new Error('Fill in the issuer id, the key id and the .p8 key\'s text.');
    let token;
    try { token = await ascToken(key); } catch { throw new Error('That is not a valid .p8 key.'); }
    await asc('/apps?limit=1', { token });
    await keychainWrite(APPLE, JSON.stringify(key));
  } else {
    throw new Error(`Unknown store: ${spec.store}`);
  }
  cache.clear();
  return {};
}

function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = { STORE_APPS, getInstalls, getConfig, saveConfig, startAppStoreReports, parsePlayInstalls, parseAppSessions, decodeReport, asResult };
