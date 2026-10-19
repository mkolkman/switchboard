const { execFile } = require('child_process');

// Bugsnag, read for the Observability tab: the errors of a backend's
// production project in a stretch of time, and its event counts over time.
// Read-only, with a personal auth token kept in the keychain (service
// switchboard-bugsnag-token, account bugsnag) and read through
// /usr/bin/security, as the Grafana token is. Bugsnag allows ten requests a
// minute: every call goes through one queue that keeps to that, and answers
// are kept for a few minutes.

const TOKEN_SERVICE = 'switchboard-bugsnag-token';
const ACCOUNT = 'bugsnag';
const API = 'https://api.bugsnag.com';
const RATE = 10; // requests
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;

function readToken() {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', TOKEN_SERVICE, '-a', ACCOUNT, '-w'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim() || null);
    });
  });
}

// --- The queue: at most RATE requests in any RATE_WINDOW_MS ---

const sent = []; // times of the requests in the last window
let queue = Promise.resolve();

function slot() {
  const next = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] >= RATE_WINDOW_MS) sent.shift();
      if (sent.length < RATE) { sent.push(now); return; }
      await new Promise(r => setTimeout(r, RATE_WINDOW_MS - (now - sent[0]) + 50));
    }
  });
  queue = next.catch(() => {});
  return next;
}

async function api(apiPath, params = []) {
  const token = await readToken();
  if (!token) throw new Error('No Bugsnag token yet.');
  const q = new URLSearchParams(params);
  for (let attempt = 0; attempt < 3; attempt++) {
    await slot();
    const res = await fetch(`${API}${apiPath}${params.length ? `?${q}` : ''}`, { headers: { Authorization: `token ${token}`, 'X-Version': '2', Accept: 'application/json' } });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, (Number(res.headers.get('retry-after')) || 10) * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { const j = JSON.parse(text); message = j.errors?.join('; ') || j.error || message; } catch {}
      throw new Error(res.status === 401 ? 'Bugsnag does not accept the token.' : `Bugsnag: ${message || res.status}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Bugsnag keeps saying to slow down; try again in a minute.');
}

const cache = new Map(); // key → { at, promise }

function cached(key, make, { force = false } = {}) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = make().catch(err => { cache.delete(key); throw err; });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** The organization's projects by slug, with the organization's slug for dashboard links. */
function projects() {
  return cached('projects', async () => {
    const orgs = await api('/user/organizations');
    const out = new Map();
    for (const org of orgs || []) {
      for (const p of await api(`/organizations/${org.id}/projects`, [['per_page', '100']]) || []) {
        out.set(p.slug, { id: p.id, slug: p.slug, name: p.name, org: org.slug });
      }
    }
    return out;
  });
}

async function project(slug) {
  const p = (await projects()).get(slug);
  if (!p) throw new Error(`Bugsnag has no project ${slug}.`);
  return p;
}

const filter = (field, value) => [[`filters[${field}][][type]`, 'eq'], [`filters[${field}][][value]`, value]];

/** Whether a token is set (never the token itself). */
async function getConfig() {
  return { hasToken: !!(await readToken()), service: TOKEN_SERVICE, account: ACCOUNT };
}

/**
 * A production project's errors that had events between `since` and `until`
 * (ISO; until may be null for now), most events first:
 * [{ id, errorClass, message, context, file, events, users, firstSeen, lastSeen, severity, status, url, project }].
 */
function errorsBetween(slug, since, until = null, { force = false } = {}) {
  return cached(`errors|${slug}|${since}|${until}`, async () => {
    const p = await project(slug);
    const params = [['per_page', '30'], ['sort', 'events'], ...filter('app.release_stage', 'production'), ...filter('event.since', since)];
    if (until) params.push(...filter('event.before', until));
    const list = await api(`/projects/${p.id}/errors`, params);
    return (list || []).map(e => ({
      id: e.id,
      errorClass: e.error_class || '',
      message: e.message || '',
      context: e.context || '',
      file: e.grouping_fields?.file || '',
      events: e.events || 0,
      users: e.users || 0,
      firstSeen: e.first_seen_unfiltered || e.first_seen || null,
      lastSeen: e.last_seen || null,
      severity: e.severity || 'error',
      status: e.status || '',
      url: `https://app.bugsnag.com/${p.org}/${p.slug}/errors/${e.id}`,
      project: p.slug,
      projectId: p.id,
    }));
  }, { force });
}

/** Production events of a project per bucket between two times: [{ from, to, events }]. */
function eventTrend(slug, since, until, buckets, { force = false } = {}) {
  return cached(`trend|${slug}|${since}|${until}|${buckets}`, async () => {
    const p = await project(slug);
    const params = [['buckets_count', String(buckets)], ...filter('app.release_stage', 'production'), ...filter('event.since', since), ...filter('event.before', until)];
    const list = await api(`/projects/${p.id}/trend`, params);
    return (list || []).map(b => ({ from: b.from, to: b.to, events: b.events_count || 0 }));
  }, { force });
}

/** How a session reads Bugsnag itself: the token from the keychain, never in the prompt. */
function sessionToolsNote() {
  return 'To look further, read the Bugsnag token from the keychain and call its Data Access API (at most ten requests a minute):\n'
    + '```\n'
    + `BUGSNAG_TOKEN=$(security find-generic-password -s ${TOKEN_SERVICE} -a ${ACCOUNT} -w)\n`
    + `curl -s -H "Authorization: token $BUGSNAG_TOKEN" -H "X-Version: 2" "${API}/projects/<project id>/errors/<error id>/latest_event"\n`
    + '```\n'
    + 'Only production. Never print the token.';
}

module.exports = { TOKEN_SERVICE, ACCOUNT, getConfig, errorsBetween, eventTrend, sessionToolsNote };
