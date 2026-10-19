const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Flags for the Observability tab: which switches decide whether a feature is
// there at all in a production version, and how they stand now. Backends:
// the env() switches in config/ at the production tag, valued from the
// production .env in 1Password (the item deploy.yml names at that tag; only
// the flag keys are kept, the rest of the file is dropped at once). Apps: the
// flag functions in their flag files at the production tag (remote, debug
// builds only, or fixed), valued from Firebase Remote Config, read with the
// gcloud Application Default Credentials. Insider and premium rules are left
// out. Each flag points at the PR that added it, found with `git log -S` in
// the local clone. Read-only.

const OP_ACCOUNT = 'movelabstudio.1password.com';
const CACHE_MS = 10 * 60 * 1000;

// Env keys that are flags by their name; a component can name more.
const ENV_FLAG = /(_ENABLED?$|^ENABLE_|FEATURE|_FLAG$|_MAINTENANCE$)/;
// Switches about running the service rather than what users get, as whole
// parts of a snake_case key or camelCase name.
const TECHNICAL_WORDS = /(^|_)(PROMETHEUS|TRACING|PULSE|SLOW|GRAPHIQL|APQ|TELESCOPE|DEBUG|LOG|LOGS|METRICS?|PROFILER|PROFILING|LOKALISE)(_|$)/;

/** Whether a flag key or name is about running the service. */
function isTechnical(name) {
  return TECHNICAL_WORDS.test(String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
}

// --- Reading what the code says ---

/** Laravel config: every env('KEY', default) whose key is a flag (or named in `extra`): [{ key, fallback, file }]. */
function envFlagsInConfig(files, extra = []) {
  const out = [];
  const seen = new Set();
  for (const { file, text } of files) {
    for (const m of String(text || '').matchAll(/env\(\s*['"]([A-Z0-9_]+)['"]\s*(?:,\s*([^)]*?))?\s*\)/g)) {
      const key = m[1];
      if (seen.has(key) || !(ENV_FLAG.test(key) || extra.includes(key))) continue;
      seen.add(key);
      out.push({ key, fallback: m[2] != null ? m[2].trim().replace(/^['"]|['"]$/g, '') : null, file });
    }
  }
  return out;
}

/** KEY=VALUE lines of a .env, as a Map (quotes taken off, comments skipped). */
function parseDotenv(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** "on", "off" or the value itself. */
function flagValue(raw) {
  const v = String(raw ?? '').trim().replace(/^\(?bool\)?\s*/i, '');
  if (/^(true|1|on|yes|\(true\))$/i.test(v)) return 'on';
  if (/^(false|0|off|no|\(false\)|null|)$/i.test(v)) return 'off';
  return v;
}

/**
 * The flags a Kotlin or Swift flag file defines: each public Boolean val or
 * function and how production decides it: { name, how: 'remote', key } for a
 * Remote Config key (a debug-build shortcut beside it does not matter in a
 * release), 'debug' for debug builds only, 'fixed' with a value; insider-,
 * premium- and permission-based ones are left out, as are ones it cannot read.
 */
function appFlagsInFile(text) {
  // Comments out first: a doc comment can name another flag's rule.
  const src = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');
  const consts = new Map();
  for (const m of src.matchAll(/(?:const\s+val|let)\s+(\w+)\s*(?::\s*String)?\s*=\s*"([^"]+)"/g)) consts.set(m[1], m[2]);
  const defs = [...src.matchAll(/^[ \t]*((?:(?:public|internal|private|override|open|static|final)\s+)*)(?:val|fun|func|var)\s+(\w+)\s*(\(\))?\s*(?::\s*Bool(?:ean)?|->\s*Bool)?\s*[={]?/gm)];
  const out = [];
  defs.forEach((m, i) => {
    const mods = m[1] || '';
    const name = m[2];
    if (/private/.test(mods)) return;
    const body = src.slice(m.index + m[0].length, defs[i + 1]?.index ?? src.length);
    const head = m[0];
    // Booleans only: a typed one, or an expression that can only be one.
    const typed = /Boolean|Bool\b/.test(head);
    if (!typed && !/^\s*(BuildConfig\.DEBUG|true|false)\b/.test(body)) return;
    if (/hasAccess|hasPermission|entitlement|premium|subscription|customerInfo|UserPermissions/i.test(body)) return;
    const remote = body.match(/(?:getBoolean|getBool|configValue)\s*\(\s*(?:forKey:\s*)?(?:"([^"]+)"|(\w+))\s*\)/);
    if (remote) {
      const key = remote[1] || consts.get(remote[2]);
      if (key) out.push({ name, how: 'remote', key });
      return;
    }
    if (/Insider/i.test(body)) return;
    if (/BuildConfig\.DEBUG|isDebugBuild\(\)|#if DEBUG/.test(body)) { out.push({ name, how: 'debug' }); return; }
    const fixed = body.match(/^\s*(?:get\(\)\s*=\s*|return\s+|\{\s*return\s+)?(true|false)\b/);
    if (fixed && !/\breturn\b[\s\S]*\breturn\b/.test(body)) out.push({ name, how: 'fixed', value: fixed[1] === 'true' ? 'on' : 'off' });
  });
  return out;
}

// --- Remote Config ---

/**
 * A Remote Config parameter as the tab shows it: the value for everyone,
 * and per condition (by name only: expressions can name people) or rollout
 * the value it gives. { value, conditions: [{ name, value, percent }] }.
 */
function remoteValue(param) {
  if (!param) return null;
  const conditions = Object.entries(param.conditionalValues || {}).map(([name, v]) => ({
    name,
    value: flagValue(v.rolloutValue?.value ?? v.value),
    percent: v.rolloutValue?.percent ?? null,
  }));
  return { value: flagValue(param.defaultValue?.value ?? (param.defaultValue?.useInAppDefault ? 'off' : '')), conditions };
}

let adcToken = null; // { token, until }

/** An access token from the gcloud Application Default Credentials. */
async function googleToken() {
  if (adcToken && Date.now() < adcToken.until) return adcToken.token;
  const file = path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
  let creds;
  try { creds = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('No Google login: run `gcloud auth application-default login`.'); }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error('The Google login has expired: run `gcloud auth application-default login`.');
  adcToken = { token: json.access_token, until: Date.now() + (json.expires_in || 3600) * 1000 - 60000 };
  return adcToken.token;
}

const remoteCache = new Map(); // project → { at, promise }

/** A Firebase project's Remote Config: { parameters (groups flattened), updated }. */
function readRemoteConfig(project, { force = false } = {}) {
  const hit = remoteCache.get(project);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = (async () => {
    const res = await fetch(`https://firebaseremoteconfig.googleapis.com/v1/projects/${project}/remoteConfig`, {
      headers: { Authorization: `Bearer ${await googleToken()}`, 'x-goog-user-project': project },
    });
    if (!res.ok) throw new Error(`Remote Config of ${project}: ${res.status}`);
    const json = await res.json();
    const parameters = { ...(json.parameters || {}) };
    for (const g of Object.values(json.parameterGroups || {})) Object.assign(parameters, g.parameters || {});
    return { parameters, updated: json.version?.updateTime || null };
  })().catch(err => { remoteCache.delete(project); throw err; });
  remoteCache.set(project, { at: Date.now(), promise });
  return promise;
}

// --- 1Password ---

/** The op:// reference a deploy workflow reads the production .env from (the tag side of its ternary). */
function productionEnvRef(workflow) {
  const line = String(workflow || '').split('\n').find(l => /LOCATION_1PASSWORD_ENV\s*:/.test(l));
  const m = line?.match(/refs\/tags\/'\)\s*&&\s*'(op:\/\/[^']+)'/) || line?.match(/(op:\/\/[^'"\s]+)/);
  return m ? m[1] : null;
}

const envCache = new Map(); // op ref → { at, promise }

/**
 * The flag keys (and only those) of a 1Password .env item, and when the item
 * last changed: { values: Map, title, updated }.
 */
function readEnvItem(ref, keys, { force = false } = {}) {
  const cacheKey = `${ref}|${keys.join(',')}`;
  const hit = envCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const [, vault, item] = ref.match(/^op:\/\/([^/]+)\/([^/]+)\//) || [];
  if (!vault) return Promise.reject(new Error(`Not a 1Password reference: ${ref}`));
  const promise = new Promise((resolve, reject) => {
    execFile('op', ['item', 'get', item, '--vault', vault, '--account', OP_ACCOUNT, '--format', 'json'], {
      timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`1Password: ${String(stderr || err.message).trim().split('\n')[0]}`)); return; }
      try {
        const json = JSON.parse(stdout);
        const notes = (json.fields || []).find(f => f.id === 'notesPlain' || f.purpose === 'NOTES')?.value || '';
        const all = parseDotenv(notes);
        resolve({ values: new Map(keys.filter(k => all.has(k)).map(k => [k, all.get(k)])), title: json.title || '', updated: json.updated_at || null });
      } catch (e) {
        reject(new Error(`1Password answered something unexpected: ${e.message}`));
      }
    });
  }).catch(err => { envCache.delete(cacheKey); throw err; });
  envCache.set(cacheKey, { at: Date.now(), promise });
  return promise;
}

// --- Where a flag came from ---

const addedCache = new Map(); // "repo|needle" → Promise<sha|null>

/** The local clone of a MoveLab repo, or null. */
function localClone(repo) {
  for (const dir of [path.join(os.homedir(), 'Sources', repo), path.join(os.homedir(), 'dev', repo)]) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/** The first commit that added a text to some paths, in the local clone (its own history, nothing fetched). */
function commitThatAdded(repo, needle, paths) {
  const key = `${repo}|${needle}|${paths.join(',')}`;
  if (addedCache.has(key)) return addedCache.get(key);
  const dir = localClone(repo);
  const promise = !dir ? Promise.resolve(null) : new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', '--all', '--reverse', '--format=%H', `-S${needle}`, '--', ...paths], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).split('\n')[0].trim() || null);
    });
  });
  addedCache.set(key, promise);
  return promise;
}

module.exports = {
  OP_ACCOUNT, isTechnical, envFlagsInConfig, parseDotenv, flagValue, appFlagsInFile, remoteValue,
  readRemoteConfig, productionEnvRef, readEnvItem, commitThatAdded,
};
