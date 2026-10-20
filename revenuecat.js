const { execFile } = require('child_process');

// RevenueCat, read for the Production tab: per product its project's
// overview (active subscriptions, MRR, trials, revenue), in euros as
// RevenueCat reports them on request (never converted here). Read-only:
// per product a project id and a v2 secret key with only
// charts_metrics:overview:read, kept together in the keychain (service
// switchboard-revenuecat-<product>, account revenuecat) and read through
// /usr/bin/security, as the other tokens are.

const ACCOUNT = 'revenuecat';
const API = 'https://api.revenuecat.com/v2';
const CACHE_MS = 15 * 60 * 1000;
const PRODUCTS = ['mlc', 'nohrd', 'waterrower', 'cityrow', 'drwolff', 'rp3'];
// Project ids known from the backends' own code, offered when connecting.
const KNOWN_PROJECTS = { waterrower: '07893d7d' };

const serviceOf = (product) => `switchboard-revenuecat-${product}`;

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

/** A product's project id and key, or null. */
async function credentials(product) {
  const raw = await keychainRead(serviceOf(product));
  if (!raw) return null;
  try {
    const { projectId, key } = JSON.parse(raw);
    return projectId && key ? { projectId, key } : null;
  } catch {
    return null;
  }
}

/**
 * The overview's figures by RevenueCat's metric ids: { subscriptions, mrr,
 * trials, revenue, newCustomers }, null where it has none.
 */
function shapeOverview(json) {
  const byId = new Map((json?.metrics || []).map(m => [m.id, m]));
  const value = (id) => (byId.has(id) && Number.isFinite(Number(byId.get(id).value)) ? Number(byId.get(id).value) : null);
  return {
    subscriptions: value('active_subscriptions'),
    mrr: value('mrr'),
    trials: value('active_trials'),
    revenue: value('revenue'), // the last 28 days
    newCustomers: value('new_customers'), // the last 28 days
  };
}

/** One project's overview in euros. RevenueCat labels money "$" whatever the currency asked for. */
async function fetchOverview({ projectId, key }) {
  const res = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/metrics/overview?currency=EUR`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try { message = JSON.parse(text).message || message; } catch {}
    throw new Error(res.status === 401 || res.status === 403 ? 'RevenueCat does not accept this key (it needs charts_metrics:overview:read).' : `RevenueCat: ${message || res.status}`);
  }
  return shapeOverview(JSON.parse(text));
}

/** Which products are connected (never the keys), and the project ids known to suggest. */
async function getConfig() {
  const connected = {};
  for (const product of PRODUCTS) {
    const c = await credentials(product);
    connected[product] = c ? { projectId: c.projectId } : null;
  }
  return { connected, known: KNOWN_PROJECTS };
}

/** Save a product's project id and key, after checking them with RevenueCat. */
async function saveConfig({ product, projectId, key }) {
  if (!PRODUCTS.includes(product)) throw new Error(`Unknown product: ${product}`);
  const creds = { projectId: String(projectId || '').trim(), key: String(key || '').trim() };
  if (!creds.projectId || !creds.key) throw new Error('Fill in the project id and the key.');
  await fetchOverview(creds);
  await keychainWrite(serviceOf(product), JSON.stringify(creds));
  cache.delete(product);
  return {};
}

const cache = new Map(); // product → { at, promise }

/** Every connected product's overview: { product: figures | { error } }. */
async function getOverviews({ force = false } = {}) {
  const out = {};
  await Promise.all(PRODUCTS.map(async (product) => {
    const creds = await credentials(product);
    if (!creds) return;
    const hit = cache.get(product);
    if (force || !hit || Date.now() - hit.at > CACHE_MS) {
      const promise = fetchOverview(creds).catch(err => { cache.delete(product); throw err; });
      cache.set(product, { at: Date.now(), promise });
    }
    try { out[product] = await cache.get(product).promise; } catch (err) { out[product] = { error: err.message || String(err) }; }
  }));
  return { products: out };
}

function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = { PRODUCTS, getConfig, saveConfig, getOverviews, shapeOverview, asResult };
