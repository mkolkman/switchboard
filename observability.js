// Observability: MoveLab's products as one whole for the Observability tab.
// A product (MLC, NOHRD, WaterRower, CITYROW, RP3) is made of components: a
// backend or an app, each a repo released with mls (release.toml). This module
// knows the products and components, and reads per component what runs where
// (GitHub Releases, their Targets and Promotions tables, the production
// deployments), what a version holds: the merged PRs between two tags,
// grouped per linked issue, and how it fares: a backend's Bugsnag errors
// while the version ran, and its flags (observability-flags.js). Grafana's
// alerts, figures and logs come from grafana.js; the renderer puts them on
// the same components. Read-only.

const { graphql, parseReleaseTargets, releaseModel } = require('./github-tracker');
const bugsnag = require('./bugsnag');
const flagsSource = require('./observability-flags');

const OWNER = 'MoveLab-Studio';
const STAGES = ['internal', 'beta', 'production'];
const CACHE_MS = 5 * 60 * 1000;

// Files (and routes) of a backend that serve one product only: WaterRower's
// in the NOHRD backends, CITYROW's in MLC Web. And the shared code of a
// Laravel backend, which serves every product on it.
const WATERROWER_FILES = /(^|\/)water_?rower/i;
const CITYROW_FILES = /(^|\/)city_?row/i;
const SHARED_BACKEND_FILES = /^(app\/Models\/|app\/Http\/Middleware\/|app\/Http\/Controllers\/Auth\/|app\/Auth|config\/|database\/migrations\/|composer\.(json|lock)$)/;
// MoveLab-Connect-Android builds the commercial (machine) apps of the other products too.
const COMMERCIAL_ELSEWHERE = /^(rp3|nohrd|waterrower|dr_wolff)[-_]/;

/**
 * The products in the sidebar's order; `owner` is the product that owns
 * one (CITYROW and Dr. Wolff are NOHRD's). A component is one repo (or the
 * targets of one in a repo shipping several apps): kind backend or app,
 * `targets` the mls targets it is made of (a list, or a pattern `only` or `not`
 * matching their names; none: all of the repo's), `files`
 * which changed files (and errors) make a PR part of it, `grafana` its
 * platform and Loki app in grafana.js, `bugsnag` its production projects,
 * `flagFiles` an app's flag code and `firebase` its Remote Config project,
 * `envFlags` env keys of a backend that are flags without a flag's name.
 * A backend serving two products is a component under each, each seeing its
 * own part of the code: the NOHRD backends serve NOHRD and WaterRower, MLC
 * Web serves MLC and CITYROW.
 */
const PRODUCTS = [
  { id: 'mlc', label: 'MLC', short: 'MLC', components: [
    { id: 'mlc-web', label: 'Web', kind: 'backend', repo: 'MoveLab-Connect-Web', grafana: { platform: 'mlc', app: 'MoveLabConnect' }, bugsnag: ['movelab-connect-production'], envFlags: ['CITYROW_IDENTITY_PROVIDER'], files: { not: CITYROW_FILES } },
    { id: 'mlc-android', label: 'Android', kind: 'app', repo: 'MoveLab-Connect-Android', targets: { not: COMMERCIAL_ELSEWHERE }, flagFiles: ['utils/featureflags/src/main/kotlin/mls/connect/utils/featureflags/FeatureFlags.kt'], firebase: 'movelab-connect' },
  ] },
  { id: 'nohrd', label: 'NOHRD', short: 'NH', components: [
    { id: 'nohrd-account', label: 'Account', kind: 'backend', repo: 'NOHRD-Account', grafana: { platform: 'nohrd', app: 'nohrd-account' }, bugsnag: ['nohrd-account-production'], files: { not: WATERROWER_FILES } },
    { id: 'nohrd-data', label: 'Data', kind: 'backend', repo: 'NOHRD-Data', grafana: { platform: 'nohrd', app: 'nohrd-data' }, bugsnag: ['nohrd-data-production'], files: { not: WATERROWER_FILES } },
    { id: 'nohrd-fixed', label: 'Fixed', kind: 'app', repo: 'NOHRD-Fixed', bugsnag: ['slimbeam-fixed', 'wall-fixed', 'watergrinder-fixed'] },
    { id: 'nohrd-connect', label: 'NOHRD Connect', kind: 'app', repo: 'WATERROWER-NOHRD-Connect', targets: ['nca', 'nci'], flagFiles: ['nohrd-connect/nohrd-app-android/featureflags/src/main/java/nohrd/featureflags/FeatureFlags.kt', 'nohrd-connect/nohrd-app-ios/Flags/Sources/FeatureFlags.swift'], firebase: 'nohrd-app' },
    { id: 'nohrd-commercial', label: 'Commercial', kind: 'app', repo: 'MoveLab-Connect-Android', targets: { only: /^nohrd[-_]/ } },
  ] },
  { id: 'waterrower', label: 'WaterRower', short: 'WR', components: [
    { id: 'waterrower-connect', label: 'WATERROWER Connect', kind: 'app', repo: 'WATERROWER-NOHRD-Connect', targets: ['wra', 'wri'], flagFiles: ['waterrower-connect/waterrower-connect-android/featureflags/src/main/java/waterrower/connect/featureflags/FeatureFlags.kt', 'waterrower-connect/waterrower-connect-ios/iOS/Flags/Sources/FeatureFlags.swift'], firebase: 'waterrower-monitor' },
    { id: 'waterrower-account', label: 'Account', kind: 'backend', repo: 'NOHRD-Account', grafana: { platform: 'nohrd', app: 'nohrd-account' }, bugsnag: ['nohrd-account-production'], files: { only: WATERROWER_FILES, shared: SHARED_BACKEND_FILES } },
    { id: 'waterrower-data', label: 'Data', kind: 'backend', repo: 'NOHRD-Data', grafana: { platform: 'nohrd', app: 'nohrd-data' }, bugsnag: ['nohrd-data-production'], files: { only: WATERROWER_FILES, shared: SHARED_BACKEND_FILES } },
    { id: 'waterrower-commercial', label: 'Commercial', kind: 'app', repo: 'MoveLab-Connect-Android', targets: { only: /^waterrower[-_]/ } },
  ] },
  { id: 'cityrow', label: 'CITYROW', short: 'CR', owner: 'nohrd', components: [
    { id: 'cityrow-app', label: 'App', kind: 'app', repo: 'CityRow-App', flagFiles: ['android/app/src/main/kotlin/com/cityrowgo/featureflags/RemoteConfigFeatureFlagsSource.kt', 'ios/App/Sources/RemoteConfigFeatureFlagsSource.swift'], firebase: 'cityrow-64783' },
    { id: 'cityrow-web', label: 'Web', kind: 'backend', repo: 'MoveLab-Connect-Web', grafana: { platform: 'mlc', app: 'MoveLabConnect' }, bugsnag: ['movelab-connect-production'], envFlags: ['CITYROW_IDENTITY_PROVIDER'], files: { only: CITYROW_FILES, shared: SHARED_BACKEND_FILES } },
  ] },
  { id: 'drwolff', label: 'Dr. Wolff', short: 'DW', owner: 'nohrd', components: [
    { id: 'drwolff-commercial', label: 'Commercial', kind: 'app', repo: 'MoveLab-Connect-Android', targets: { only: /^dr_wolff[-_]/ } },
  ] },
  { id: 'rp3', label: 'RP3', short: 'RP3', components: [
    { id: 'rp3-web', label: 'Web', kind: 'backend', repo: 'RP3-Rowing-Web', grafana: { platform: 'rp3', app: 'rp3' }, bugsnag: ['rp3-analyze-production', 'rp3-analyze-front-end-production'] },
    { id: 'rp3-app', label: 'App', kind: 'app', repo: 'RP3-App', flagFiles: ['android/featureflags/src/main/java/rp3/featureflags/FeatureFlags.kt'], firebase: 'rp3-rowing' },
    { id: 'rp3-commercial', label: 'Commercial', kind: 'app', repo: 'MoveLab-Connect-Android', targets: { only: /^rp3[-_]/ } },
  ] },
];

function findComponent(id) {
  for (const p of PRODUCTS) {
    const c = p.components.find(x => x.id === id);
    if (c) return { ...c, product: p.id };
  }
  return null;
}

// --- Release bodies ---

/** The rows of a Markdown table whose first header is `first`, as objects keyed by the lowercased headers. */
function markdownTable(body, first) {
  const lines = String(body || '').split('\n');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const start = lines.findIndex(l => /^\s*\|/.test(l) && cells(l)[0].toLowerCase() === first.toLowerCase());
  if (start < 0) return [];
  const heads = cells(lines[start]).map(h => h.toLowerCase());
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const row = cells(line);
    if (row[0].startsWith('**')) continue; // a totals row
    rows.push(Object.fromEntries(heads.map((h, i) => [h, row[i] ?? ''])));
  }
  return rows;
}

/**
 * When each target reached each stage, from an mls Release body's Promotions
 * table: { target: { stage: "YYYY-MM-DD" } }, the first promotion winning.
 */
function parsePromotions(body) {
  const out = {};
  for (const row of markdownTable(body, 'Date').filter(r => 'stage' in r && 'targets' in r)) {
    const stage = row.stage.toLowerCase();
    for (const target of row.targets.split(',').map(t => t.trim()).filter(Boolean)) {
      out[target] = out[target] || {};
      if (!out[target][stage]) out[target][stage] = row.date;
    }
  }
  return out;
}

/** The one-line summary a tagged release body carries ("Changes: …"), or null. */
function releaseSummary(body) {
  const m = String(body || '').match(/^Changes:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// --- What runs where ---

const repoCache = new Map(); // repo → { at, promise }

/**
 * A repo's tags (oldest first) with their Release, its release model, its
 * risk.products paths and its latest production and staging deployments.
 */
function readRepo(repo, { force = false } = {}) {
  const hit = repoCache.get(repo);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = graphql(`query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      url
      defaultBranchRef { name }
      toml: object(expression: "HEAD:release.toml") { ... on Blob { text } }
      refs(refPrefix: "refs/tags/", first: 60, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes {
        name target { __typename oid ... on Commit { committedDate } ... on Tag { target { oid ... on Commit { committedDate } } } }
      } }
      releases(first: 40, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName publishedAt url description } }
      production: deployments(environments: ["production"], first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ref { name } createdAt latestStatus { state } } }
      staging: deployments(environments: ["staging"], first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ref { name } sha: commitOid createdAt latestStatus { state } } }
    }
  }`, { owner: OWNER, repo })
    .then(data => {
      const r = data?.repository;
      if (!r) throw new Error(`${OWNER}/${repo} was not found.`);
      const releases = new Map((r.releases?.nodes || []).map(n => [n.tagName, n]));
      const tags = (r.refs?.nodes || []).map(n => {
        const rel = releases.get(n.name);
        return {
          name: n.name,
          sha: n.target?.target?.oid || n.target?.oid || null,
          date: rel?.publishedAt || n.target?.committedDate || n.target?.target?.committedDate || null,
          url: rel?.url || null,
          summary: releaseSummary(rel?.description),
          targets: parseReleaseTargets(rel?.description),
          promotions: parsePromotions(rel?.description),
        };
      }).filter(t => t.date).sort((a, b) => new Date(a.date) - new Date(b.date));
      const ok = (d) => d.latestStatus?.state === 'SUCCESS';
      return {
        url: r.url,
        branch: r.defaultBranchRef?.name || 'main',
        model: releaseModel(r.toml?.text),
        tags,
        production: (r.production?.nodes || []).find(ok) || null,
        staging: (r.staging?.nodes || []).find(ok) || null,
      };
    })
    .catch(err => { repoCache.delete(repo); throw err; });
  repoCache.set(repo, { at: Date.now(), promise });
  return promise;
}

/**
 * Where a component stands: per target (or the one "production" line of a
 * tagged backend) the tag on each stage, its date and rollout; the tags as a
 * list for the version picker (newest first, with the stages they reached).
 *
 *   { model, url, branch, targets: [{ name, stages: { internal|beta|production: { tag, date, rollout } } }],
 *     tags: [{ name, date, url, summary, stages: [...] }], staging: { sha, date } | null }
 */
/**
 * A repo's current targets. A Release's table lists the targets it was
 * published for, sometimes only a few, and older ones may carry renamed
 * targets: take the fullest of the last ten tables and those after it.
 */
function currentTargets(tags) {
  const tables = tags.filter(t => t.targets).slice(-10).reverse().map(t => Object.keys(t.targets));
  if (!tables.length) return [];
  const full = tables.reduce((best, names, i) => (names.length > tables[best].length ? i : best), 0);
  return [...new Set(tables.slice(0, full + 1).reverse().flat())];
}

/** The target names of a component among the repo's current ones. */
function targetNames(component, available) {
  const t = component.targets;
  if (!t) return available;
  if (Array.isArray(t)) return t;
  return available.filter(n => (!t.only || t.only.test(n)) && (!t.not || !t.not.test(n)));
}

function componentState(component, info) {
  const tagged = info.model !== 'staged';
  const tagList = info.tags;
  let targets;
  if (tagged) {
    // A tag deploys production; the production deployment says which one runs.
    const deployed = info.production?.ref?.name;
    const tag = tagList.find(t => t.name === deployed) || tagList[tagList.length - 1] || null;
    targets = [{ name: null, stages: tag ? { production: { tag: tag.name, date: info.production?.createdAt || tag.date, rollout: 100 } } : {} }];
  } else {
    targets = targetNames(component, currentTargets(tagList)).map(name => {
      const stages = {};
      for (const stage of STAGES) {
        // The newest tag that reached this stage for this target.
        const tag = [...tagList].reverse().find(t => t.targets?.[name]?.[stage] !== undefined);
        if (tag) stages[stage] = { tag: tag.name, date: tag.promotions?.[name]?.[stage] || tag.date, rollout: tag.targets[name][stage] };
      }
      return { name, stages };
    });
  }
  const names = targets.map(t => t.name);
  const mine = (t) => tagged || (t.targets ? names.some(n => t.targets[n]) : !component.targets);
  const tags = tagList.filter(mine).slice().reverse().map(t => ({
    name: t.name, date: t.date, url: t.url, summary: t.summary,
    stages: tagged ? [] : STAGES.filter(s => names.some(n => t.targets?.[n]?.[s] !== undefined)),
  }));
  const staging = tagged && info.staging ? { sha: info.staging.sha, date: info.staging.createdAt } : null;
  return { model: tagged ? 'tagged' : 'staged', url: info.url, branch: info.branch, targets, tags, staging };
}

/** Every product with its components' state; a component that cannot be read carries its error. */
async function getOverview({ force = false } = {}) {
  const products = await Promise.all(PRODUCTS.map(async (p) => ({
    id: p.id,
    label: p.label,
    short: p.short,
    owner: p.owner || null,
    components: await Promise.all(p.components.map(async (c) => {
      const base = { id: c.id, label: c.label, kind: c.kind, repo: c.repo, grafana: c.grafana || null, bugsnag: c.bugsnag || [], product: p.id, filtered: !!c.files, flags: c.kind === 'backend' || !!c.flagFiles };
      try {
        return { ...base, ...componentState(c, await readRepo(c.repo, { force })) };
      } catch (err) {
        return { ...base, error: err.message || String(err) };
      }
    })),
  })));
  return { products };
}

// --- What a version holds ---

const BOTS = /^(dependabot|renovate|github-actions)(\[bot\])?$/i;
const CHORE_TITLE = /^(\s*\[[^\]]*\])*\s*(\[infra\]|bump\b|update (the )?dependenc|update .* to v?\d|chore\b|build\b|ci\b|refactor\b|deps?\b|release\b)/i;
const CHORE_LABELS = /^(dependencies|chore|ci|build|refactor|infra)$/i;

/** Whether a PR is upkeep (builds, bumps, refactors) rather than something a user notices. */
function isChore(pr) {
  if (BOTS.test(pr.author || '')) return true;
  if ((pr.labels || []).some(l => CHORE_LABELS.test(l))) return true;
  return CHORE_TITLE.test(pr.title || '');
}

/**
 * Whether a PR is part of a component that sees only some of the repo:
 * `only` its own files (or `shared` ones serving it too), `not` anything but
 * those. Without the file list (over 100 files) it counts.
 */
function prMatchesFiles(pr, files) {
  if (!files) return true;
  const paths = pr.files || [];
  if (!paths.length || pr.filesTotal > paths.length) return true;
  if (files.only) return paths.some(p => files.only.test(p) || files.shared?.test(p));
  if (files.not) return paths.some(p => !files.not.test(p));
  return true;
}

/** The files a target ships from, from release.toml's [risk.products] table. */
function riskProductPaths(toml) {
  const out = {};
  const section = String(toml || '').split(/^\[risk\.products\]\s*$/m)[1];
  if (!section) return out;
  const body = section.split(/^\[/m)[0];
  for (const m of body.matchAll(/^\s*([\w-]+)\s*=\s*\[([\s\S]*?)\]/gm)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  }
  return out;
}

/**
 * Whether a PR is part of an app made of some of a repo's targets: it changes
 * a file of one of them, or a file none of the targets own (shared code).
 */
function prMatchesTargets(pr, targets, productPaths) {
  if (!targets || !Object.keys(productPaths || {}).length) return true;
  const paths = pr.files || [];
  if (!paths.length || pr.filesTotal > paths.length) return true;
  const owner = (file) => Object.keys(productPaths).filter(t => productPaths[t].some(prefix => file.startsWith(prefix)));
  return paths.some(file => { const o = owner(file); return !o.length || o.some(t => targets.includes(t)); });
}

/**
 * The PRs of a version as the tab shows them: per linked issue, the issues
 * under the pitch or map they belong to (parent), then the PRs without an
 * issue ("other"), and the upkeep apart ("chores").
 *
 *   { groups: [{ parent: { number, title, url } | null, issues: [{ issue, prs }] }], other: [pr], chores: [pr] }
 */
function groupFeatures(prs) {
  const parents = new Map(); // parent number (or 0) → { parent, issues: Map }
  const other = [];
  const chores = [];
  for (const pr of prs) {
    const issues = pr.issues || [];
    if (!issues.length) { (isChore(pr) ? chores : other).push(pr); continue; }
    for (const issue of issues) {
      const key = issue.parent?.number || 0;
      if (!parents.has(key)) parents.set(key, { parent: issue.parent || null, issues: new Map() });
      const group = parents.get(key);
      if (!group.issues.has(issue.number)) group.issues.set(issue.number, { issue, prs: [] });
      group.issues.get(issue.number).prs.push(pr);
    }
  }
  // Pitches and maps first, then the issues on their own; each by the issue numbers.
  const groups = [...parents.values()]
    .sort((a, b) => (a.parent ? 0 : 1) - (b.parent ? 0 : 1) || (a.parent?.number || 0) - (b.parent?.number || 0))
    .map(g => ({ parent: g.parent, issues: [...g.issues.values()].sort((a, b) => a.issue.number - b.issue.number) }));
  return { groups, other, chores };
}

const COMPARE_PAGES = 3;
const featureCache = new Map(); // "repo|base|head" → promise of the PRs

/** The merged PRs whose commits are in `head` but not in `base` (up to 300 commits). */
function comparePrs(repo, base, head) {
  const key = `${repo}|${base}|${head}`;
  if (featureCache.has(key)) return featureCache.get(key);
  const promise = (async () => {
    const prs = new Map();
    let after = null;
    let truncated = false;
    for (let page = 0; page < COMPARE_PAGES; page++) {
      const data = await graphql(`query($owner: String!, $repo: String!, $base: String!, $head: String!, $after: String) {
        repository(owner: $owner, name: $repo) { ref(qualifiedName: $base) { compare(headRef: $head) {
          commits(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { associatedPullRequests(first: 2) { nodes {
            number title url mergedAt baseRefName author { login } labels(first: 10) { nodes { name } }
            closingIssuesReferences(first: 5) { nodes { number title url state parent { number title url } } }
            files(first: 100) { totalCount nodes { path } }
          } } } }
        } } }
      }`, { owner: OWNER, repo, base: `refs/tags/${base}`, head, after });
      const commits = data?.repository?.ref?.compare?.commits;
      if (!commits) throw new Error(`Could not compare ${base} with ${head} in ${repo}.`);
      for (const c of commits.nodes || []) {
        for (const p of c.associatedPullRequests?.nodes || []) {
          if (!p.mergedAt || prs.has(p.number)) continue;
          prs.set(p.number, {
            number: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt, author: p.author?.login || '',
            labels: (p.labels?.nodes || []).map(l => l.name),
            issues: (p.closingIssuesReferences?.nodes || []).map(i => ({ number: i.number, title: i.title, url: i.url, state: i.state, parent: i.parent || null })),
            files: (p.files?.nodes || []).map(f => f.path),
            filesTotal: p.files?.totalCount || 0,
          });
        }
      }
      if (!commits.pageInfo?.hasNextPage) break;
      after = commits.pageInfo.endCursor;
      if (page === COMPARE_PAGES - 1) truncated = true;
    }
    return { prs: [...prs.values()].sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt)), truncated };
  })().catch(err => { featureCache.delete(key); throw err; });
  featureCache.set(key, promise);
  return promise;
}

/**
 * What a version of a component holds: the PRs between the tag before it and
 * the tag (or, with `staging`, between the production tag and the default
 * branch: what staging runs and production does not yet), filtered to the
 * component's part of the repo and grouped.
 */
async function getFeatures({ component: id, tag = null, staging = false }) {
  const { base, head, truncated, prs, first } = await versionPrs(id, tag, staging);
  return { base, head, truncated, first, ...groupFeatures(prs) };
}

/** The PRs of a version (see getFeatures), filtered to the component, as a flat list. */
async function versionPrs(id, tag, staging = false) {
  const component = findComponent(id);
  if (!component) throw new Error(`Unknown component: ${id}`);
  const info = await readRepo(component.repo);
  const state = componentState(component, info);
  let base;
  let head;
  if (staging) {
    base = state.targets[0]?.stages?.production?.tag;
    head = info.branch;
    if (!base) throw new Error('No production tag to compare with.');
  } else {
    // The tag before it among this component's tags (a hotfix tag compares with its own line's predecessor by date too).
    const names = state.tags.map(t => t.name); // newest first
    const at = names.indexOf(tag);
    if (at < 0) throw new Error(`${tag} is not a tag of ${component.repo}.`);
    head = tag;
    base = names[at + 1];
    if (!base) return { base: null, head, prs: [], first: true };
  }
  const { prs, truncated } = await comparePrs(component.repo, base, head);
  const targets = component.targets ? state.targets.map(t => t.name) : null;
  const paths = targets ? riskProductPaths(await readToml(component.repo)) : null;
  const mine = prs.filter(pr => prMatchesFiles(pr, component.files) && prMatchesTargets(pr, targets, paths));
  return { base, head, truncated, prs: mine };
}

// --- How a version fares ---

/**
 * When a version ran in production: from its deploy (the production
 * deployment for the tag that runs now, else the Release's date) to the next
 * version's, or now. `previous` is the stretch of the version before it.
 * Tags newest first.
 */
function versionWindow(state, tag) {
  const tags = state.tags;
  const at = tags.findIndex(t => t.name === tag);
  if (at < 0) return null;
  const prodTag = state.targets.map(t => t.stages?.production).filter(Boolean).find(p => p.tag === tag);
  const start = (i) => (i === at && prodTag ? prodTag.date : tags[i]?.date || null);
  const since = start(at);
  const until = at > 0 ? tags[at - 1].date : null;
  const previous = tags[at + 1] ? { since: tags[at + 1].date, until: since } : null;
  return { since, until, previous };
}

/**
 * Whether an error is part of a component that sees only some of the code.
 * Its route decides first (a request on a product's route is that product's,
 * whatever code it failed in), then its top file, as for PRs.
 */
function errorMatchesFiles(error, files) {
  if (!files) return true;
  const own = files.only || files.not;
  if (error.context && own.test(error.context)) return !!files.only;
  if (!error.file) return true;
  if (files.only) return files.only.test(error.file) || !!files.shared?.test(error.file);
  return !files.not.test(error.file);
}

/** The PRs of a version that changed the file an error comes from. */
function prsForError(error, prs) {
  if (!error.file) return [];
  return prs.filter(pr => (pr.files || []).includes(error.file)).map(({ number, title, url }) => ({ number, title, url }));
}

/** Events an hour over a trend, or null without one. */
function eventsPerHour(trend) {
  if (!trend?.length) return null;
  const hours = (new Date(trend[trend.length - 1].to) - new Date(trend[0].from)) / 3600000;
  return hours > 0 ? trend.reduce((n, b) => n + b.events, 0) / hours : null;
}

/**
 * How a version of a backend fares in Bugsnag: the errors with events while
 * it ran (new ones, first seen after its deploy, first; each with the PRs of
 * the version that changed its file), and with `rate` the events an hour
 * against the version before it.
 */
async function getProblems({ component: id, tag, rate = false, force = false }) {
  const component = findComponent(id);
  if (!component) throw new Error(`Unknown component: ${id}`);
  if (!component.bugsnag?.length) return { errors: [], projects: [] };
  if (!(await bugsnag.getConfig()).hasToken) return { errors: [], projects: component.bugsnag, noToken: true };
  const state = componentState(component, await readRepo(component.repo));
  const window = versionWindow(state, tag);
  if (!window?.since) throw new Error(`${tag} has no date to start from.`);
  const [lists, prs] = await Promise.all([
    Promise.all(component.bugsnag.map(slug => bugsnag.errorsBetween(slug, window.since, window.until, { force }))),
    versionPrs(id, tag).then(r => r.prs).catch(() => []),
  ]);
  const since = new Date(window.since).getTime();
  const errors = lists.flat()
    .filter(e => errorMatchesFiles(e, component.files))
    .map(e => ({ ...e, isNew: !!e.firstSeen && new Date(e.firstSeen).getTime() >= since, prs: prsForError(e, prs) }))
    .sort((a, b) => (b.isNew - a.isNew) || b.events - a.events);
  let rates = null;
  if (rate && window.previous) {
    // The same length of time on both sides of the deploy, at most a week.
    const span = Math.min(7 * 86400000, (window.until ? new Date(window.until) : Date.now()) - since, since - new Date(window.previous.since).getTime());
    if (span > 3600000) {
      const iso = (t) => new Date(t).toISOString();
      const [now, before] = await Promise.all([
        Promise.all(component.bugsnag.map(slug => bugsnag.eventTrend(slug, iso(since), iso(since + span), 1, { force }))),
        Promise.all(component.bugsnag.map(slug => bugsnag.eventTrend(slug, iso(since - span), iso(since), 1, { force }))),
      ]);
      const sum = (lists) => lists.reduce((n, t) => n + (eventsPerHour(t) || 0), 0);
      rates = { now: sum(now), before: sum(before), hours: span / 3600000 };
    }
  }
  return { since: window.since, until: window.until, projects: component.bugsnag, errors, rates };
}

const tomlCache = new Map();

function readToml(repo) {
  if (!tomlCache.has(repo)) {
    tomlCache.set(repo, graphql(`query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { object(expression: "HEAD:release.toml") { ... on Blob { text } } } }`, { owner: OWNER, repo })
      .then(d => d?.repository?.object?.text || '')
      .catch(err => { tomlCache.delete(repo); throw err; }));
  }
  return tomlCache.get(repo);
}

// --- Flags ---

/** The newest tag in production on any of a component's targets, with its date. */
function productionOf(state) {
  const order = state.tags.map(t => t.name); // newest first
  return state.targets.map(t => t.stages?.production).filter(Boolean).sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag))[0] || null;
}

/** Files at a tag, as { path: text } (missing ones left out). */
async function filesAt(repo, tag, paths) {
  if (!paths.length) return {};
  const data = await graphql(`query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {
    ${paths.map((p, i) => `f${i}: object(expression: ${JSON.stringify(`${tag}:${p}`)}) { ... on Blob { text } }`).join('\n    ')}
  } }`, { owner: OWNER, repo });
  return Object.fromEntries(paths.map((p, i) => [p, data?.repository?.[`f${i}`]?.text]).filter(([, text]) => text != null));
}

/** The config/ files of a Laravel repo at a tag (one level of subfolders). */
async function configAt(repo, tag) {
  const data = await graphql(`query($owner: String!, $repo: String!, $expr: String!) { repository(owner: $owner, name: $repo) {
    object(expression: $expr) { ... on Tree { entries { name object { ... on Blob { text } ... on Tree { entries { name object { ... on Blob { text } } } } } } } }
  } }`, { owner: OWNER, repo, expr: `${tag}:config` });
  const files = [];
  for (const e of data?.repository?.object?.entries || []) {
    if (e.object?.text != null) files.push({ file: `config/${e.name}`, text: e.object.text });
    for (const sub of e.object?.entries || []) if (sub.object?.text != null) files.push({ file: `config/${e.name}/${sub.name}`, text: sub.object.text });
  }
  return files;
}

/** The PRs of commits (by sha), as { sha: { number, title, url } }. */
async function prsOfCommits(repo, shas) {
  const list = [...new Set(shas.filter(Boolean))];
  if (!list.length) return {};
  const data = await graphql(`query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {
    ${list.map((sha, i) => `c${i}: object(oid: ${JSON.stringify(sha)}) { ... on Commit { associatedPullRequests(first: 1) { nodes { number title url } } } }`).join('\n    ')}
  } }`, { owner: OWNER, repo }).catch(() => null);
  return Object.fromEntries(list.map((sha, i) => [sha, data?.repository?.[`c${i}`]?.associatedPullRequests?.nodes?.[0] || null]));
}

/** Each flag's PR: the one whose commit first added its key (in the local clone). */
async function addPrs(repo, flags, needleOf, paths) {
  const shas = await Promise.all(flags.map(f => flagsSource.commitThatAdded(repo, needleOf(f), paths)));
  const prs = await prsOfCommits(repo, shas);
  flags.forEach((f, i) => { f.pr = (shas[i] && prs[shas[i]]) || null; });
}

const flagKind = (...names) => (names.some(n => n && flagsSource.isTechnical(n)) ? 'technical' : 'feature');

/** A Remote Config key without its platform suffix, and the platform it names. */
function remoteKeyBase(key) {
  const m = String(key).match(/^(.*)_(android|ios)$/i);
  return m ? { base: m[1], platform: /ios/i.test(m[2]) ? 'iOS' : 'Android' } : { base: String(key), platform: null };
}

/**
 * The flags of a component's production version and how they stand now.
 * A backend: { source: 'env', tag, flags: [{ name, kind, value, from: 'env'|'default', file, pr }],
 * env: { title, updated, deployed, changedAfterDeploy } }. An app: { source: 'app', tag,
 * flags: [{ name, kind, platforms: { Android|iOS: { how, key, value, conditions, missing } }, pr }],
 * remoteOnly: [{ key, value, conditions }], remote: { project, updated } }.
 */
async function getFlags({ component: id, force = false }) {
  const component = findComponent(id);
  if (!component) throw new Error(`Unknown component: ${id}`);
  const state = componentState(component, await readRepo(component.repo, { force }));
  const prod = productionOf(state);
  const tag = prod?.tag || state.tags[0]?.name;
  if (!tag) return { source: null, flags: [] };

  if (component.kind === 'backend') {
    const [config, workflow] = await Promise.all([
      configAt(component.repo, tag),
      filesAt(component.repo, tag, ['.github/workflows/deploy.yml']).then(f => f['.github/workflows/deploy.yml']),
    ]);
    const found = flagsSource.envFlagsInConfig(config, component.envFlags || []);
    const ref = flagsSource.productionEnvRef(workflow);
    let env = null;
    let envError = null;
    if (ref) {
      try {
        const item = await flagsSource.readEnvItem(ref, found.map(f => f.key), { force });
        const deployed = prod?.date || null;
        env = { title: item.title, updated: item.updated, deployed, changedAfterDeploy: !!(deployed && item.updated && new Date(item.updated) > new Date(deployed)), values: item.values };
      } catch (err) { envError = err.message; }
    }
    const flags = found.map(f => {
      const set = env?.values.has(f.key);
      return { name: f.key, kind: flagKind(f.key), value: flagsSource.flagValue(set ? env.values.get(f.key) : f.fallback), from: set ? 'env' : 'default', file: f.file };
    });
    await addPrs(component.repo, flags, f => f.name, ['config']);
    if (env) delete env.values;
    return { source: 'env', tag, flags, env, envError: envError || (ref ? null : 'deploy.yml names no 1Password item for production.') };
  }

  const files = await filesAt(component.repo, tag, component.flagFiles || []);
  let remote = null;
  let remoteError = null;
  if (component.firebase) {
    try { remote = await flagsSource.readRemoteConfig(component.firebase, { force }); } catch (err) { remoteError = err.message; }
  }
  // One row per flag: the same name, or the same Remote Config key (without
  // its platform suffix), on Android and iOS.
  const rows = [];
  const rowFor = (name, key) => rows.find(r => r.name === name || (key && r.bases.includes(remoteKeyBase(key).base)));
  const used = new Set();
  for (const [file, text] of Object.entries(files)) {
    const platform = /\.swift$|(^|\/)ios\//i.test(file) ? 'iOS' : 'Android';
    for (const f of flagsSource.appFlagsInFile(text)) {
      let row = rowFor(f.name, f.key);
      if (!row) { row = { name: f.name, platforms: {}, keys: [], bases: [] }; rows.push(row); }
      let entry = { how: f.how, value: f.how === 'debug' ? 'off' : f.value || null };
      if (f.how === 'remote') {
        used.add(f.key);
        row.keys.push(f.key);
        row.bases.push(remoteKeyBase(f.key).base);
        const param = remote?.parameters?.[f.key];
        const v = flagsSource.remoteValue(param);
        entry = { how: 'remote', key: f.key, value: v ? v.value : remote ? 'off' : null, conditions: v?.conditions || [], missing: !!remote && !param };
      }
      row.platforms[platform] = entry;
    }
  }
  // A key for the other platform that this version's flag code does not read goes on its row, marked.
  for (const [key, param] of Object.entries(remote?.parameters || {})) {
    const { base, platform } = remoteKeyBase(key);
    const row = !used.has(key) && platform && rows.find(r => r.bases.includes(base));
    if (!row || row.platforms[platform]) continue;
    used.add(key);
    const v = flagsSource.remoteValue(param);
    row.platforms[platform] = { how: 'remote', key, value: v.value, conditions: v.conditions, notInCode: true };
  }
  const flags = rows.map(r => ({ name: r.name, kind: flagKind(r.name, ...r.keys), platforms: r.platforms, keys: r.keys }));
  await addPrs(component.repo, flags, f => f.keys[0] || f.name, component.flagFiles || []);
  flags.forEach(f => delete f.keys);
  const remoteOnly = Object.entries(remote?.parameters || {})
    .filter(([key, p]) => !used.has(key) && (p.valueType === 'BOOLEAN' || /^(true|false)$/.test(p.defaultValue?.value || '')))
    .map(([key, p]) => ({ key, kind: flagKind(key), ...flagsSource.remoteValue(p) }));
  return { source: 'app', tag, flags, remoteOnly, remote: component.firebase ? { project: component.firebase, updated: remote?.updated || null } : null, remoteError };
}

function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = {
  PRODUCTS, findComponent, getOverview, getFeatures, getProblems, getFlags, asResult,
  versionWindow, errorMatchesFiles, prsForError, eventsPerHour,
  markdownTable, parsePromotions, releaseSummary, componentState, currentTargets, isChore, prMatchesFiles, prMatchesTargets, riskProductPaths, groupFeatures,
};
