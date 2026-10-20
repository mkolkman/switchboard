const { execFile } = require('child_process');

// Grafana (the MoveLab monitoring stack), read live for the Grafana tab:
// alert rules and their state, the dashboards, Prometheus and Loki through
// Grafana's datasource proxy. Read-only: a service account token with the
// Viewer role, kept in the keychain with the URL and read through
// /usr/bin/security (as the Help Scout credentials are), so a Claude session
// can use the same token. Only production is looked at.

const URL_SERVICE = 'switchboard-grafana-url';
const TOKEN_SERVICE = 'switchboard-grafana-token';
const ACCOUNT = 'grafana';
const DEFAULT_URL = 'https://monitoring.mls-cdn.net';
// Grafana's auto-generated datasource UIDs (MoveLab-Connect-Web .ops/monitoring/
// grafana/provisioning/datasources/datasource.yml says why they are not pinned).
const PROMETHEUS_UID = 'PBFA97CFB590B2093';
const LOKI_UID = 'P8E80F9AEF21F6940';
const ENV = 'prod';
const ERROR_LEVELS = 'error|critical|emergency|alert';

// What tells the platforms apart: the Prometheus job, the Loki app, the metric
// prefix, and the repo a Claude session looks in. RP3 only ships logs.
const PLATFORMS = [
  { id: 'mlc', label: 'MLC', jobs: ['movelab-connect'], apps: ['MoveLabConnect'], prefix: 'mlc', repos: { MoveLabConnect: 'MoveLab-Connect-Web' } },
  { id: 'nohrd', label: 'NOHRD', jobs: ['nohrd-account', 'nohrd-data'], apps: ['nohrd-account', 'nohrd-data'], prefix: 'wna|wnd', repos: { 'nohrd-account': 'NOHRD-Account', 'nohrd-data': 'NOHRD-Data' } },
  { id: 'rp3', label: 'RP3', jobs: [], apps: ['rp3'], prefix: null, repos: { rp3: 'RP3-Rowing-Web' } },
];

// --- Credentials ---

function keychainRead(service) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim() || null);
    });
  });
}

function keychainWrite(service, value) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', value], { timeout: 10000 }, (err) => {
      if (err) reject(new Error(`Could not save to the keychain: ${err.message}`));
      else resolve();
    });
  });
}

async function credentials() {
  const [url, token] = await Promise.all([keychainRead(URL_SERVICE), keychainRead(TOKEN_SERVICE)]);
  return { url: (url || DEFAULT_URL).replace(/\/+$/, ''), token };
}

/** The URL, whether a token is set (never the token itself), and the platforms. */
async function getConfig() {
  const { url, token } = await credentials();
  return { url, hasToken: !!token, platforms: PLATFORMS.map(({ id, label, apps, repos }) => ({ id, label, apps, repos })) };
}

/** Save the URL and token, after checking the token with Grafana. */
async function saveConfig({ url, token }) {
  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('The URL must start with https://');
  const value = String(token || '').trim();
  if (!value) throw new Error('Paste the service account token.');
  const res = await fetch(`${base}/api/search?limit=1`, { headers: { Authorization: `Bearer ${value}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'Grafana does not accept this token.' : `Grafana answered ${res.status}.`);
  await keychainWrite(URL_SERVICE, base);
  await keychainWrite(TOKEN_SERVICE, value);
  return {};
}

async function api(apiPath) {
  const { url, token } = await credentials();
  if (!token) throw new Error('No Grafana token yet.');
  const res = await fetch(url + apiPath, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try { const j = JSON.parse(text); message = j.message || j.error || message; } catch {}
    throw new Error(`Grafana: ${message || res.status}`);
  }
  return text ? JSON.parse(text) : null;
}

// --- Alerts and dashboards ---

/** The platform an alert is about, from its query's metric names or app labels; null for infrastructure. */
function alertPlatform(text) {
  const t = String(text || '');
  if (/\bmlc_|MoveLabConnect|movelab-connect/.test(t)) return 'mlc';
  if (/\bwn[ad]_|nohrd/i.test(t)) return 'nohrd';
  if (/\brp3\b/i.test(t)) return 'rp3';
  return null;
}

/** The Loki apps (services) an alert's query is about, from its metric prefixes: picks the NOHRD repo. */
function alertApps(text) {
  const t = String(text || '');
  return [/\bmlc_/.test(t) && 'MoveLabConnect', /\bwna_/.test(t) && 'nohrd-account', /\bwnd_/.test(t) && 'nohrd-data'].filter(Boolean);
}

/**
 * Every Grafana-managed alert rule with its state, firing first, then pending,
 * then the rest by name: { uid, title, group, folder, state, health, query,
 * labels, annotations, activeAt, value, platform, apps, instances }.
 */
async function getAlerts() {
  const data = await api('/api/prometheus/grafana/api/v1/rules');
  const rules = [];
  for (const group of data?.data?.groups || []) {
    for (const r of group.rules || []) {
      const alerts = r.alerts || [];
      const active = alerts.filter(a => /firing|alerting|pending/i.test(a.state || ''));
      const state = String(r.state || 'inactive').toLowerCase();
      rules.push({
        uid: r.uid || r.labels?.__alert_rule_uid__ || `${group.name}/${r.name}`,
        title: r.name,
        group: group.name,
        folder: group.file || '',
        state: state === 'alerting' ? 'firing' : state,
        health: r.health || '',
        query: r.query || '',
        labels: Object.fromEntries(Object.entries(r.labels || {}).filter(([k]) => !k.startsWith('__'))),
        // The rule's annotations are templates; a firing instance carries them filled in.
        annotations: active[0]?.annotations || r.annotations || {},
        activeAt: active.map(a => a.activeAt).filter(Boolean).sort()[0] || null,
        value: active[0]?.value ?? null,
        instances: active.map(a => ({ state: /alerting|firing/i.test(a.state || '') ? 'firing' : String(a.state || '').toLowerCase(), labels: a.labels || {}, activeAt: a.activeAt || null, value: a.value ?? null })),
        platform: alertPlatform(`${r.query || ''} ${JSON.stringify(r.labels || {})}`),
        apps: alertApps(r.query),
      });
    }
  }
  const rank = { firing: 0, pending: 1 };
  return { alerts: rules.sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || a.title.localeCompare(b.title)) };
}

/** The dashboards by folder: { uid, title, folder, url } (url is Grafana's own path). */
async function getDashboards() {
  const hits = await api('/api/search?type=dash-db&limit=200');
  return { dashboards: (hits || []).map(d => ({ uid: d.uid, title: d.title, folder: d.folderTitle || 'General', url: d.url })) };
}

// --- Prometheus and Loki through the datasource proxy ---

const PROM = `/api/datasources/proxy/uid/${PROMETHEUS_UID}/api/v1`;
const LOKI = `/api/datasources/proxy/uid/${LOKI_UID}/loki/api/v1`;

/** A Prometheus range query: [{ labels, points: [[t, v], ...] }]. */
async function promRange(expr, { start, end, step }) {
  const q = new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) });
  const data = await api(`${PROM}/query_range?${q}`);
  return (data?.data?.result || []).map(s => ({ labels: s.metric || {}, points: (s.values || []).map(([t, v]) => [Number(t), Number(v)]) }));
}

/** A Loki metric query over a range, the same shape as promRange. */
async function lokiRange(expr, { start, end, step }) {
  const q = new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) });
  const data = await api(`${LOKI}/query_range?${q}`);
  return (data?.data?.result || []).map(s => ({ labels: s.metric || {}, points: (s.values || []).map(([t, v]) => [Number(t), Number(v)]) }));
}

/**
 * A platform narrowed to one of its services: its job, its Loki app and its
 * metric prefix sit at the same place in their lists. Unknown: the platform.
 */
function serviceOf(platform, app) {
  const i = app ? platform.apps.indexOf(app) : -1;
  if (i < 0) return platform;
  const prefixes = String(platform.prefix || '').split('|');
  return {
    ...platform,
    apps: [app],
    jobs: platform.jobs.length === platform.apps.length ? [platform.jobs[i]] : platform.jobs,
    prefix: platform.prefix && prefixes.length === platform.apps.length ? prefixes[i] : platform.prefix,
  };
}

const regexOf = (list) => list.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/**
 * Five figures for a platform, or one of its services (`app`, its Loki app),
 * each a series over the last hour (one point a minute) summed across the
 * services: requests/s (and the same hour a week ago), 5xx ratio, p95
 * latency, error logs a minute, queue backlog. A figure without data is null.
 */
async function getVitals(platformId, app = '') {
  const platform = PLATFORMS.find(x => x.id === platformId);
  if (!platform) throw new Error(`Unknown platform: ${platformId}`);
  const p = serviceOf(platform, app);
  // On whole minutes, so Prometheus and Loki points share their timestamps.
  const end = Math.floor(Date.now() / 60000) * 60;
  const range = { start: end - 3600, end, step: 60 };
  const job = `job=~"${regexOf(p.jobs)}", env="${ENV}"`;
  const one = (series) => {
    if (!series.length) return null;
    const byT = new Map();
    for (const s of series) for (const [t, v] of s.points) if (Number.isFinite(v)) byT.set(t, (byT.get(t) || 0) + v);
    return [...byT].sort((a, b) => a[0] - b[0]);
  };
  const safe = (promise) => promise.then(one).catch(() => null);
  const prom = (expr) => (p.jobs.length ? safe(promRange(expr, range)) : Promise.resolve(null));
  const [requests, requestsWeekAgo, errors5xx, p95, errorLogs, backlog] = await Promise.all([
    prom(`sum(job_env:http_requests:rate5m{${job}})`),
    prom(`sum(job_env:http_requests:rate5m{${job}} offset 7d)`),
    prom(`max(job_env:http_5xx:ratio5m{${job}})`),
    prom(`max(job_env:http_request_duration_seconds:p95{${job}})`),
    safe(lokiRange(`sum(count_over_time({app=~"${regexOf(p.apps)}", env="${ENV}", level=~"${ERROR_LEVELS}"}[1m]))`, range)),
    p.prefix ? prom(`sum({__name__=~"(${p.prefix})_queue_length", env="${ENV}"})`) : Promise.resolve(null),
  ]);
  // Loki has no series for a minute without errors: those minutes are zero.
  const counted = new Map(errorLogs || []);
  const errorsPerMinute = [];
  for (let t = range.start; t <= end; t += 60) errorsPerMinute.push([t, counted.get(t) || 0]);
  return { platform: p.id, requests, requestsWeekAgo, errors5xx, p95, errorLogs: errorsPerMinute, backlog };
}

/**
 * The LogQL for the log search: the platform's apps (or one of them) in prod,
 * the levels, and a text it must contain. A raw query is used as it is.
 */
function logQuery({ platform, app = '', levels = [], contains = '', raw = '' }) {
  if (String(raw).trim()) return String(raw).trim();
  const p = PLATFORMS.find(x => x.id === platform);
  if (!p) throw new Error(`Unknown platform: ${platform}`);
  const apps = app && p.apps.includes(app) ? [app] : p.apps;
  let q = `{app=~"${regexOf(apps)}", env="${ENV}"${levels.length ? `, level=~"${regexOf(levels)}"` : ''}}`;
  if (String(contains).trim()) q += ` |= ${JSON.stringify(String(contains).trim())}`;
  return q;
}

/**
 * Log lines, newest first: { query, lines: [{ ts (ns string), time (ms), line, labels }] }.
 * `since` (ns string) returns only what came after it, for the live view.
 */
async function getLogs(spec) {
  const query = logQuery(spec);
  const endNs = BigInt(Date.now()) * 1000000n;
  const rangeNs = BigInt(Math.max(60, Number(spec.rangeSeconds) || 3600)) * 1000000000n;
  const startNs = spec.since ? BigInt(spec.since) + 1n : endNs - rangeNs;
  const q = new URLSearchParams({ query, start: String(startNs), end: String(endNs), limit: String(Math.min(Number(spec.limit) || 500, 5000)), direction: 'backward' });
  const data = await api(`${LOKI}/query_range?${q}`);
  if (data?.data?.resultType && data.data.resultType !== 'streams') throw new Error('That query returns numbers, not log lines.');
  const lines = [];
  for (const stream of data?.data?.result || []) {
    for (const [ts, line] of stream.values || []) lines.push({ ts, time: Number(BigInt(ts) / 1000000n), line, labels: stream.stream || {} });
  }
  lines.sort((a, b) => (BigInt(b.ts) > BigInt(a.ts) ? 1 : BigInt(b.ts) < BigInt(a.ts) ? -1 : 0));
  return { query, lines };
}

/** The lines around one (same stream), oldest first, for its context. */
async function getLogContext({ labels, ts, around = 20 }) {
  const selector = `{${Object.entries(labels || {}).filter(([k]) => /^(app|env|filename)$/.test(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}}`;
  const center = BigInt(ts);
  const span = 15n * 60n * 1000000000n;
  const fetchSide = async (direction) => {
    const q = new URLSearchParams({ query: selector, start: String(direction === 'backward' ? center - span : center), end: String(direction === 'backward' ? center + 1n : center + span), limit: String(around + 1), direction });
    const data = await api(`${LOKI}/query_range?${q}`);
    return (data?.data?.result || []).flatMap(s => (s.values || []).map(([t, line]) => ({ ts: t, time: Number(BigInt(t) / 1000000n), line })));
  };
  const [before, after] = await Promise.all([fetchSide('backward'), fetchSide('forward')]);
  const seen = new Set();
  const lines = [...before, ...after].filter(l => (seen.has(l.ts + l.line) ? false : seen.add(l.ts + l.line)))
    .sort((a, b) => (BigInt(a.ts) > BigInt(b.ts) ? 1 : BigInt(a.ts) < BigInt(b.ts) ? -1 : 0));
  return { lines };
}

/** An alert's own query over the hour around it (or the last hour), for its graph. */
async function getAlertSeries({ query, activeAt }) {
  const at = activeAt ? Math.floor(Date.parse(activeAt) / 1000) : Math.floor(Date.now() / 1000);
  const end = Math.min(Math.floor(Date.now() / 1000), at + 1800);
  const start = end - 3600;
  if (!String(query || '').trim()) return { series: [] };
  const series = await promRange(query, { start, end, step: 60 }).catch(() => []);
  return { series: series.slice(0, 8) };
}

// --- Business figures (the backends' business_* gauges) ---

/** A Prometheus instant query: [{ labels, value }]. */
async function promInstant(expr) {
  const data = await api(`${PROM}/query?${new URLSearchParams({ query: expr })}`);
  return (data?.data?.result || []).map(s => ({ labels: s.metric || {}, value: Number(s.value?.[1]) })).filter(s => Number.isFinite(s.value));
}

const BUSINESS_WINDOWS = ['1d', '7d', '30d'];

/**
 * The business_* gauges as one model per product, each figure with its value
 * now and one window back (`before`, via offset; null without history):
 * { users: { kind: { window: { now, before } } }, workouts: { all, channels, types } (each
 * { window: { now, before } }), duration / distance: { type: { window: median } }, strava,
 * accounts, training: { kind: { window: value } }, subscriptions, mrr, extra: { name: { window: value } } }.
 * `queries` holds the answers keyed as businessQueries() names them.
 */
function shapeBusiness(queries) {
  const products = {};
  const of = (id) => (products[id] = products[id] || { users: {}, workouts: { all: {}, channels: {}, types: {} }, duration: {}, distance: {}, training: {}, extra: {}, strava: null, accounts: null, subscriptions: null, mrr: null });
  const put = (obj, path, value) => {
    let o = obj;
    for (const k of path.slice(0, -1)) o = o[k] = o[k] || {};
    o[path[path.length - 1]] = value;
  };
  // Values now, and the same window one window back.
  const pair = (name, keyOf) => {
    const out = new Map();
    for (const s of queries[name] || []) out.set(keyOf(s.labels), { labels: s.labels, now: s.value, before: null });
    for (const w of BUSINESS_WINDOWS) {
      for (const s of queries[`${name}@${w}`] || []) {
        if (s.labels.window !== w) continue;
        const hit = out.get(keyOf(s.labels));
        if (hit) hit.before = s.value;
      }
    }
    return [...out.values()];
  };
  for (const r of pair('users', l => `${l.product}|${l.kind}|${l.window}`)) {
    const { product, kind, window } = r.labels;
    if (kind === 'accounts') of(product).accounts = r.now;
    else put(of(product).users, [kind, window], { now: r.now, before: r.before });
  }
  for (const [name, field] of [['workouts', 'all'], ['workoutsByChannel', 'channels'], ['workoutsByType', 'types']]) {
    for (const r of pair(name, l => `${l.product}|${l.channel || ''}|${l.type || ''}|${l.window}`)) {
      const { product, channel, type, window } = r.labels;
      const path = field === 'all' ? ['all', window] : field === 'channels' ? ['channels', channel, window] : ['types', type, window];
      put(of(product).workouts, path, { now: r.now, before: r.before });
    }
  }
  for (const [name, field] of [['duration', 'duration'], ['distance', 'distance']]) {
    for (const s of queries[name] || []) {
      const { product, type, window, channel } = s.labels;
      if (channel && channel !== 'app') continue; // the apps' medians; machines differ too much to mix in
      put(of(product)[field], [type, window], s.value);
    }
  }
  for (const s of queries.strava || []) of(s.labels.product).strava = s.value;
  for (const s of queries.training || []) put(of(s.labels.product).training, [s.labels.kind, s.labels.window || 'all'], s.value);
  for (const s of queries.subscriptions || []) of(s.labels.product).subscriptions = s.value;
  for (const s of queries.mrr || []) of(s.labels.product).mrr = s.value;
  for (const s of queries.extra || []) put(of(s.labels.product).extra, [s.labels.name, s.labels.window || 'all'], s.value);
  return products;
}

/** The PromQL behind shapeBusiness, by name; `name@w` is the same one window back. */
function businessQueries() {
  const q = {
    users: 'sum by (product, kind, window) (business_users)',
    workouts: 'sum by (product, window) (business_workouts)',
    workoutsByChannel: 'sum by (product, channel, window) (business_workouts)',
    workoutsByType: 'sum by (product, type, window) (business_workouts)',
    duration: 'max by (product, channel, type, window) (business_workout_duration_seconds{quantile="0.5"})',
    distance: 'max by (product, channel, type, window) (business_workout_distance_meters{quantile="0.5"})',
    strava: 'sum by (product) (business_strava_connected)',
    training: 'sum by (product, kind, window) (business_training)',
    subscriptions: 'sum by (product) (business_subscriptions)',
    mrr: 'sum by (product) (business_mrr_euros)',
    extra: 'sum by (product, name, window) (business_extra)',
  };
  for (const name of ['users', 'workouts', 'workoutsByChannel', 'workoutsByType']) {
    for (const w of BUSINESS_WINDOWS) q[`${name}@${w}`] = q[name].replace(/\((business_\w+)\)$/, `($1{window="${w}"} offset ${w})`);
  }
  return q;
}

/** Every product's business figures; empty until the backends export them. */
async function getBusiness() {
  const queries = businessQueries();
  const answers = await Promise.all(Object.entries(queries).map(async ([name, expr]) => [name, await promInstant(expr).catch(() => [])]));
  const products = shapeBusiness(Object.fromEntries(answers));
  return { products, available: Object.keys(products).length > 0 };
}

// --- A Claude session on logs or an alert ---

/** How a session reads Grafana itself: the token and URL from the keychain, never in the prompt. */
function sessionToolsNote() {
  return 'To query further, read the Grafana URL and a read-only Viewer token from the keychain and call Grafana\'s HTTP API:\n'
    + '```\n'
    + `GRAFANA_URL=$(security find-generic-password -s ${URL_SERVICE} -a ${ACCOUNT} -w)\n`
    + `GRAFANA_TOKEN=$(security find-generic-password -s ${TOKEN_SERVICE} -a ${ACCOUNT} -w)\n`
    + `curl -sG -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA_URL${LOKI}/query_range" --data-urlencode 'query={app="MoveLabConnect", env="prod"} |= "Exception"' --data-urlencode limit=100\n`
    + `curl -sG -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA_URL${PROM}/query" --data-urlencode 'query=job_env:http_5xx:ratio5m{env="prod"}'\n`
    + '```\n'
    + 'Only production (env="prod"). Never print the token.';
}

function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = {
  PLATFORMS, DEFAULT_URL, URL_SERVICE, TOKEN_SERVICE, ACCOUNT,
  getConfig, saveConfig, getAlerts, getDashboards, getVitals, getLogs, getLogContext, getAlertSeries, getBusiness,
  shapeBusiness, businessQueries,
  alertPlatform, alertApps, logQuery, serviceOf, sessionToolsNote, asResult,
};
