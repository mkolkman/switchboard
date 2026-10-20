// Projects come from GitHub: every /wayfinder map (an issue labelled
// wayfinder:map) you are involved in, as author or assignee of the map or as
// the author of a PR that closes one of its tickets, gets a project of its
// own, made the first time it is seen and linked to the map; a closed map's
// project is done, a reopened one active again. A project already linked to
// the map is that map's, whatever its name. A session linked to one of a
// map's tickets (or the map itself) is filed under its project when it has
// none yet.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { graphql, parseRef, formatRef, getTracker } = require('./github-tracker');
const projects = require('./projects');

let db;
let log = console;

/** Main passes its db module and logger; tests pass fakes. */
function init(ctx) {
  db = ctx.db;
  log = ctx.log || console;
}

const MAP_LABEL = 'wayfinder:map';
const ORG = 'MoveLab-Studio';

const mapKey = (repo, number) => `${repo}#${number}`.toLowerCase();

/** A GraphQL call tried once more when GitHub times out (502, 503, 504). */
async function graphqlRetrying(query, variables) {
  try {
    return await graphql(query, variables);
  } catch (err) {
    if (!/GitHub answered 50[234]/.test(err.message || '')) throw err;
    await new Promise(r => setTimeout(r, 1500));
    return graphql(query, variables);
  }
}

const MAP_FIELDS = 'number title url state closedAt repository { nameWithOwner } labels(first: 20) { nodes { name } }';

/**
 * The maps you are involved in: [{ repo, number, title, url, state, key }],
 * open and closed, once each.
 */
async function getMyMaps() {
  const searches = [
    `org:${ORG} is:issue label:"${MAP_LABEL}" author:@me sort:updated-desc`,
    `org:${ORG} is:issue label:"${MAP_LABEL}" assignee:@me sort:updated-desc`,
  ];
  const [authored, assigned, prs] = await Promise.all([
    ...searches.map(q => graphqlRetrying(`query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on Issue { ${MAP_FIELDS} } } } }`, { q })),
    // Maps whose tickets your PRs close.
    graphqlRetrying(`query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
      closingIssuesReferences(first: 5) { nodes { parent { ${MAP_FIELDS} } } }
    } } } }`, { q: `org:${ORG} is:pr author:@me sort:updated-desc` }),
  ]);
  const maps = new Map();
  const add = (node) => {
    if (!node?.number || !(node.labels?.nodes || []).some(l => l.name === MAP_LABEL)) return;
    const repo = node.repository?.nameWithOwner;
    if (!repo) return;
    const key = mapKey(repo, node.number);
    if (!maps.has(key)) maps.set(key, { repo, number: node.number, title: node.title, url: node.url, state: node.state, key });
  };
  for (const n of authored?.search?.nodes || []) add(n);
  for (const n of assigned?.search?.nodes || []) add(n);
  for (const pr of prs?.search?.nodes || []) for (const i of pr.closingIssuesReferences?.nodes || []) add(i.parent);
  return [...maps.values()];
}

/** A map's title as a project name: without the "(wayfinder map)" and "Map:" markers. */
function projectName(title) {
  const name = String(title || '')
    .replace(/\s*[(—–-]+\s*wayfinder map\s*\)?\s*$/i, '')
    .replace(/^\s*(wayfinder\s+)?map:\s*/i, '')
    .trim();
  return name || String(title || '').trim();
}

/** The local clone of a repo ("owner/name"), or null. */
function localClone(repo) {
  const name = String(repo).split('/').pop();
  for (const dir of [path.join(os.homedir(), 'Sources', name), path.join(os.homedir(), 'dev', name)]) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/** The map a project is linked to ("owner/repo#n" in lower case), or null. */
function linkedMapKey(project) {
  for (const raw of project.githubRefs || []) {
    const ref = parseRef(raw);
    if (ref?.kind === 'issue') return formatRef(ref).toLowerCase();
  }
  return null;
}

/**
 * What to do for these maps given the projects there are: { create: [map],
 * status: [{ id, name, status }] }. A map with a project keeps it and only
 * its status follows the map; a closed map without one is left alone.
 */
function planMapSync(maps, rows) {
  const byMap = new Map();
  for (const row of rows) {
    const key = linkedMapKey({ githubRefs: parseRefs(row.githubRefs) });
    if (key) byMap.set(key, row);
  }
  const create = [];
  const status = [];
  for (const map of maps) {
    const want = map.state === 'OPEN' ? 'active' : 'done';
    const existing = byMap.get(map.key);
    if (existing) {
      if ((existing.status || 'active') !== want) status.push({ id: existing.id, name: existing.name, status: want });
    } else if (want === 'active') {
      create.push(map);
    }
  }
  return { create, status };
}

/**
 * Make a project for every map that has none, and keep each map project's
 * status in step with its map. Returns { created: [names], updated: [names] }.
 */
async function syncMapProjects() {
  const maps = await getMyMaps();
  const plan = planMapSync(maps, db.listProjects() || []);
  const updated = [];
  for (const change of plan.status) {
    if (!projects.updateProject(change.id, { status: change.status })?.error) updated.push(change.name);
  }
  const created = [];
  for (const map of plan.create) {
    const clone = localClone(map.repo);
    const result = await projects.createProject({ name: projectName(map.title), folders: clone ? [{ path: clone, mode: 'in-place' }] : [] });
    if (result?.error) { log.warn?.(`[project-maps] could not make a project for ${map.key}: ${result.error}`); continue; }
    const linked = projects.updateProject(result.project.id, { githubRefs: [`${map.repo}#${map.number}`] });
    if (linked?.error) log.warn?.(`[project-maps] could not link ${map.key}: ${linked.error}`);
    created.push(result.project.name);
  }
  if (created.length || updated.length) log.info?.(`[project-maps] made ${created.join(', ') || 'none'}; status of ${updated.join(', ') || 'none'}`);
  return { created, updated, maps: maps.length };
}

function parseRefs(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * File a session under the project of the map it is linked to: the map
 * itself, one of its tickets, or a PR of one. A session that has a project
 * keeps it. Returns the project id, or null.
 */
async function assignLinkedSession(sessionId, kind, ref) {
  if (!sessionId || !['issue', 'pr'].includes(kind) || !ref) return null;
  if (db.getMeta(sessionId)?.projectId) return null;
  const key = String(ref).toLowerCase();
  for (const row of db.listProjects() || []) {
    if ((row.status || 'active') !== 'active') continue;
    const map = linkedMapKey({ githubRefs: parseRefs(row.githubRefs) });
    if (!map) continue;
    if (map === key) return assign(sessionId, row.id);
    const tracker = await getTracker(map);
    if (tracker?.error || !tracker?.wayfinder) continue;
    const hit = (tracker.items || []).some(item => `${item.repo}#${item.number}`.toLowerCase() === key
      || (item.pullRequests || []).some(pr => `${pr.repo}#${pr.number}`.toLowerCase() === key));
    if (hit) return assign(sessionId, row.id);
  }
  return null;
}

function assign(sessionId, projectId) {
  const result = projects.assignSession(sessionId, projectId);
  return result?.error ? null : projectId;
}

function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = { init, getMyMaps, syncMapProjects, planMapSync, assignLinkedSession, projectName, asResult };
