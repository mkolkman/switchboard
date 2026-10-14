const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Live view of GitHub work tracked from a project: a tracking issue with the
// issues it links (and their PRs), or a GitHub Project's items. Nothing is
// written to disk; results live in memory for CACHE_MS so switching tabs does
// not refetch, and the Refresh button bypasses it.

const CACHE_MS = 2 * 60 * 1000;
const ITEM_BATCH = 20;
// The GitHub tab's merged or closed PRs: how many, newest first.
const CLOSED_PRS = 20;
const WAYFINDER_MAP_LABEL = 'wayfinder:map';
const API = 'https://api.github.com/graphql';

// --- References ---

/**
 * A reference as typed in project settings: an issue URL or `owner/repo#123`,
 * or a GitHub Project URL (orgs/<org>/projects/<n> or users/<user>/projects/<n>).
 */
function parseRef(input) {
  const text = String(input || '').trim();
  let m = text.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i);
  if (m) return { kind: 'issue', owner: m[1], repo: m[2], number: Number(m[3]) };
  m = text.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return { kind: 'issue', owner: m[1], repo: m[2], number: Number(m[3]) };
  m = text.match(/^https?:\/\/github\.com\/(orgs|users)\/([^/\s]+)\/projects\/(\d+)/i);
  if (m) return { kind: 'project', ownerType: m[1].toLowerCase() === 'orgs' ? 'organization' : 'user', owner: m[2], number: Number(m[3]) };
  return null;
}

/** The canonical text of a reference, so the same target is stored once. */
function formatRef(ref) {
  if (!ref) return '';
  if (ref.kind === 'issue') return `${ref.owner}/${ref.repo}#${ref.number}`;
  return `https://github.com/${ref.ownerType === 'organization' ? 'orgs' : 'users'}/${ref.owner}/projects/${ref.number}`;
}

/**
 * Issues an issue body links to, in the order they first appear: full issue
 * URLs and `owner/repo#n`. A bare `#n` or `repo#n` is ambiguous (issue or PR,
 * which owner) and is left out, as are PR links.
 */
function linkedIssueRefs(body, self) {
  const seen = new Set(self ? [formatRef(self).toLowerCase()] : []);
  const refs = [];
  const re = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)/g;
  for (const m of String(body || '').matchAll(re)) {
    const ref = m[1]
      ? { kind: 'issue', owner: m[1], repo: m[2], number: Number(m[3]) }
      : { kind: 'issue', owner: m[4], repo: m[5], number: Number(m[6]) };
    const key = formatRef(ref).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

// --- Status ---

const ITEM_STATUSES = ['review', 'merged', 'progress', 'todo', 'done', 'dropped'];

/**
 * Where an issue stands, from the issue and the PRs linked to it:
 * done/dropped once closed; otherwise review (an open, ready PR), merged (a
 * PR merged but the issue still open), progress (a draft PR) or todo.
 */
function itemStatus(issue) {
  if (issue.state === 'CLOSED') return issue.stateReason === 'NOT_PLANNED' ? 'dropped' : 'done';
  // A PR that closes or is linked to the issue is its work; one that only
  // mentions it counts when there is nothing better.
  const all = issue.pullRequests || [];
  const direct = all.filter(p => p.link !== 'mentions');
  const prs = direct.length ? direct : all;
  if (prs.some(p => p.state === 'OPEN' && !p.isDraft)) return 'review';
  if (prs.some(p => p.state === 'MERGED')) return 'merged';
  if (prs.some(p => p.state === 'OPEN' && p.isDraft)) return 'progress';
  return 'todo';
}

function summarize(items) {
  const counts = Object.fromEntries(ITEM_STATUSES.map(s => [s, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  const total = items.length - counts.dropped;
  return { counts, total, done: counts.done };
}

const { phasesFrom } = require('./public/github-phases');
const { latestMyReview, reviewMarkBody } = require('./public/github-my-review');

// --- GraphQL ---

// Reviewers whose approval says nothing about the code: movelabbot approves
// once it has checked that the author may merge. Bot accounts are skipped too.
const IGNORED_REVIEWERS = new Set(['movelabbot']);

function isIgnoredReviewer(author) {
  if (!author) return true;
  const login = String(author.login || '').toLowerCase();
  return author.__typename === 'Bot' || login.endsWith('[bot]') || IGNORED_REVIEWERS.has(login);
}

const PR_FIELDS = `
  number title url state isDraft reviewDecision updatedAt mergedAt mergeCommit { oid } headRefOid
  mine: reviews(last: 20, author: $me) { nodes { state body submittedAt commit { oid } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { __typename login } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } } }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const ISSUE_FIELDS = `
  id number title url state stateReason updatedAt
  milestone { number title dueOn state }
  issueFieldValues(first: 20) { nodes {
    __typename
    ... on IssueFieldSingleSelectValue { name optionId field { ... on IssueFieldSingleSelect { name } } }
    ... on IssueFieldTextValue { value field { ... on IssueFieldText { name } } }
    ... on IssueFieldNumberValue { value field { ... on IssueFieldNumber { name } } }
  } }
  repository { nameWithOwner }
  assignees(first: 5) { nodes { login } }
  labels(first: 10) { nodes { name } }
  blockedBy(first: 20) { nodes { number title url state repository { nameWithOwner } } }
  blocking(first: 20) { nodes { number title url state repository { nameWithOwner } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 40) {
    nodes {
      __typename
      ... on CrossReferencedEvent { willCloseTarget source { __typename ... on PullRequest { ${PR_FIELDS} } } }
      ... on ConnectedEvent { subject { __typename ... on PullRequest { ${PR_FIELDS} } } }
    }
  }`;

/** Changes requested or approved by a person, ignoring bots; null when neither. */
function humanReview(reviews) {
  const people = reviews.filter(r => !isIgnoredReviewer(r.author));
  if (people.some(r => r.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (people.some(r => r.state === 'APPROVED')) return 'APPROVED';
  return null;
}

function shapePr(node, link) {
  return {
    repo: node.repository?.nameWithOwner || '',
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state, // OPEN | CLOSED | MERGED
    isDraft: !!node.isDraft,
    review: node.reviewDecision || null, // GitHub's own decision, bots included
    humanReview: humanReview(node.latestOpinionatedReviews?.nodes || []),
    requested: (node.reviewRequests?.nodes || [])
      .map(n => n.requestedReviewer)
      .filter(r => r && !isIgnoredReviewer(r.__typename === 'Team' ? { login: r.name, __typename: 'Team' } : r))
      .map(r => r.login || r.name),
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt || null,
    mergeSha: node.mergeCommit?.oid || null, // what release status looks for in tags
    headOid: node.headRefOid || null,
    myReview: latestMyReview(node.mine?.nodes), // { sha, at, kind }; addReviewChanges adds changedFiles
    link, // closes | linked | mentions
  };
}

// Values of Project fields ("Wave" on a GitHub Project) for an issue's cards.
// Needs the read:project scope; without it the query is sent without this part.
const PROJECT_ITEM_FIELDS = `
  projectItems(first: 10) { nodes {
    id
    project { id number title }
    fieldValues(first: 30) { nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
    } }
  } }`;
let projectScope = true;
const isScopeError = (err) => /read:project|INSUFFICIENT_SCOPES|cannot read Projects/i.test(String(err?.message || err));

/** "projectId|fieldId": the key of a Project field, next to org fields' lowercased names. */
const projectFieldKey = (projectId, fieldId) => `${projectId}|${fieldId}`;

/** Project field values of an issue's cards, keyed by projectFieldKey. Title is left out. */
function shapeProjectValues(items) {
  const fields = {};
  const cards = {};
  for (const card of items || []) {
    const projectId = card?.project?.id;
    if (!projectId) continue;
    cards[projectId] = card.id;
    for (const v of card.fieldValues?.nodes || []) {
      const field = v?.field;
      if (!field?.id || field.name === 'Title') continue;
      const value = v.__typename === 'ProjectV2ItemFieldSingleSelectValue' ? v.name
        : v.__typename === 'ProjectV2ItemFieldTextValue' ? v.text
          : v.__typename === 'ProjectV2ItemFieldNumberValue' ? v.number : undefined;
      if (value === undefined) continue;
      fields[projectFieldKey(projectId, field.id)] = { name: field.name, value: value ?? null, optionId: v.optionId || null, itemId: card.id, projectId };
    }
  }
  return { fields, cards };
}

/** Issue field values (organisation properties such as "Wave"), keyed by lowercased field name. */
function shapeFieldValues(nodes) {
  const fields = {};
  for (const v of nodes) {
    const name = v?.field?.name;
    if (!name) continue;
    const value = v.__typename === 'IssueFieldSingleSelectValue' ? v.name : v.value;
    fields[name.toLowerCase()] = { name, value: value ?? null, optionId: v.optionId || null };
  }
  return fields;
}

const FIELD_TYPES = {
  IssueFieldSingleSelect: 'single_select', IssueFieldText: 'text', IssueFieldNumber: 'number',
  IssueFieldDate: 'date', IssueFieldMultiSelect: 'multi_select',
};
const fieldCache = new Map(); // org login → { at, promise }

const projectFieldCache = new Map(); // projectId → { at, promise }

/** A Project's fields that can hold a phase (single select, text, number), Title excluded. */
function projectFieldsOf(projectId) {
  const hit = projectFieldCache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title fields(first: 50) { nodes {
      __typename
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name dataType }
    } } } } }`, { id: projectId })
    .then(data => {
      const project = data?.node;
      if (!project) return [];
      return (project.fields?.nodes || []).map(f => {
        const type = f.__typename === 'ProjectV2SingleSelectField' ? 'single_select'
          : f.dataType === 'TEXT' ? 'text' : f.dataType === 'NUMBER' ? 'number' : null;
        if (!type || f.name === 'Title') return null;
        return {
          key: projectFieldKey(project.id, f.id), id: f.id, name: f.name, type, scope: 'project',
          projectId: project.id, projectNumber: project.number, projectTitle: project.title,
          label: `${f.name} (${project.title})`,
          options: (f.options || []).map((o, i) => ({ id: o.id, name: o.name, priority: i })),
        };
      }).filter(Boolean);
    })
    .catch(() => []);
  projectFieldCache.set(projectId, { at: Date.now(), promise });
  return promise;
}

/** Every field a phase can come from for these items: their Projects' fields first, then the org's. */
async function phaseFieldsFor(owner, items) {
  const projectIds = [...new Set(items.flatMap(i => Object.keys(i.projectCards || {})))];
  const [org, ...perProject] = await Promise.all([issueFieldsOf(owner), ...projectIds.map(projectFieldsOf)]);
  return [...perProject.flat(), ...org.map(f => ({ ...f, key: f.name.toLowerCase(), scope: 'org', label: f.name }))];
}

/** The definition behind a field key, for writing. */
async function findFieldDef(owner, key) {
  const k = String(key || '');
  if (k.includes('|')) {
    const [projectId] = k.split('|');
    return (await projectFieldsOf(projectId)).find(f => f.key === k) || null;
  }
  const def = (await issueFieldsOf(owner)).find(f => f.name.toLowerCase() === k.toLowerCase());
  return def ? { ...def, key: def.name.toLowerCase(), scope: 'org', label: def.name } : null;
}

/** The organisation's issue fields with their options; [] for a user or when not allowed. */
function issueFieldsOf(owner) {
  const key = String(owner).toLowerCase();
  const hit = fieldCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = graphql(`query($login: String!) { organization(login: $login) { issueFields(first: 50) { nodes {
      __typename
      ... on IssueFieldSingleSelect { id name options { id name priority } }
      ... on IssueFieldText { id name }
      ... on IssueFieldNumber { id name }
      ... on IssueFieldDate { id name }
      ... on IssueFieldMultiSelect { id name }
    } } } }`, { login: owner })
    .then(data => (data?.organization?.issueFields?.nodes || []).filter(n => n?.id).map(n => ({
      id: n.id, name: n.name, type: FIELD_TYPES[n.__typename] || 'other',
      options: (n.options || []).map(o => ({ id: o.id, name: o.name, priority: o.priority })),
    })))
    .catch(() => []);
  fieldCache.set(key, { at: Date.now(), promise });
  return promise;
}

function shapeDeps(connection) {
  return (connection?.nodes || []).filter(Boolean).map(n => ({
    repo: n.repository?.nameWithOwner || '', number: n.number, title: n.title, url: n.url, state: n.state,
  }));
}

/** An issue node with its PRs gathered from every way GitHub links them. */
function shapeIssue(node) {
  const prs = new Map();
  const add = (pr, link) => {
    if (!pr || pr.__typename && pr.__typename !== 'PullRequest' || !pr.number) return;
    const shaped = shapePr(pr, link);
    const key = `${shaped.repo}#${shaped.number}`;
    const rank = { closes: 0, linked: 1, mentions: 2 };
    if (!prs.has(key) || rank[link] < rank[prs.get(key).link]) prs.set(key, shaped);
  };
  for (const pr of node.closedByPullRequestsReferences?.nodes || []) add(pr, 'closes');
  for (const event of node.timelineItems?.nodes || []) {
    if (event.__typename === 'ConnectedEvent') add(event.subject, 'linked');
    else if (event.__typename === 'CrossReferencedEvent') add(event.source, event.willCloseTarget ? 'closes' : 'mentions');
  }
  const issue = {
    id: node.id || null,
    milestone: node.milestone ? { number: node.milestone.number, title: node.milestone.title, dueOn: node.milestone.dueOn || null, state: node.milestone.state } : null,
    ...(() => {
      const project = shapeProjectValues(node.projectItems?.nodes);
      return { fields: { ...shapeFieldValues(node.issueFieldValues?.nodes || []), ...project.fields }, projectCards: project.cards };
    })(),
    repo: node.repository?.nameWithOwner || '',
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    stateReason: node.stateReason || null,
    updatedAt: node.updatedAt,
    assignees: (node.assignees?.nodes || []).map(a => a.login),
    labels: (node.labels?.nodes || []).map(l => l.name),
    pullRequests: [...prs.values()].sort((a, b) => b.number - a.number),
    // GitHub's "blocked by" relations, both ways (see github-deps.js).
    blockedBy: shapeDeps(node.blockedBy),
    blocking: shapeDeps(node.blocking),
  };
  issue.status = itemStatus(issue);
  return issue;
}

let cachedToken = null;

// Finder-launched apps get a minimal PATH, so look where gh is installed too.
function ghCandidates() {
  return ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', path.join(os.homedir(), '.local/bin/gh')]
    .filter(p => p === 'gh' || fs.existsSync(p));
}

function ghToken() {
  if (cachedToken) return Promise.resolve(cachedToken);
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return Promise.resolve(env);
  const tryNext = (list) => new Promise((resolve, reject) => {
    if (!list.length) {
      reject(new Error('No GitHub login found. Install the GitHub CLI and run `gh auth login`, or set GH_TOKEN.'));
      return;
    }
    execFile(list[0], ['auth', 'token'], { timeout: 10000 }, (err, stdout) => {
      const token = String(stdout || '').trim();
      if (!err && token) resolve(token);
      else tryNext(list.slice(1)).then(resolve, reject);
    });
  });
  return tryNext(ghCandidates()).then(token => { cachedToken = token; return token; });
}

let cachedLogin = null;

/** Your GitHub login: queries that read PRs pass it as $me to find your own reviews. */
function ghLogin() {
  if (!cachedLogin) cachedLogin = graphql('query { viewer { login } }').then(d => d.viewer.login).catch(err => { cachedLogin = null; throw err; });
  return cachedLogin;
}

async function graphql(query, variables = {}) {
  const token = await ghToken();
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'Switchboard' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) cachedToken = null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.errors) throw new Error(`GitHub answered ${res.status}`);
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join('; ');
    if (/read:project|INSUFFICIENT_SCOPES/i.test(msg) || json.errors.some(e => e.type === 'INSUFFICIENT_SCOPES')) {
      throw new Error('Your GitHub token cannot read Projects. Run `gh auth refresh -s read:project` and refresh.');
    }
    // Missing items come back as NOT_FOUND alongside the rest; keep the data.
    if (!json.data) throw new Error(msg);
  }
  return json.data;
}

async function fetchIssues(refs) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < refs.length; i += ITEM_BATCH) batches.push(refs.slice(i, i + ITEM_BATCH));
  await Promise.all(batches.map(async (batch) => {
    const me = await ghLogin();
    const query = (withProjects) => `query($me: String) {\n${batch.map((r, j) =>
      `  i${j}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) { issue(number: ${r.number}) { ${ISSUE_FIELDS}${withProjects ? PROJECT_ITEM_FIELDS : ''} } }`
    ).join('\n')}\n}`;
    let data;
    try {
      data = await graphql(query(projectScope), { me });
    } catch (err) {
      if (!projectScope || !isScopeError(err)) throw err;
      projectScope = false; // read without Project fields from now on
      data = await graphql(query(false), { me });
    }
    batch.forEach((r, j) => {
      const node = data?.[`i${j}`]?.issue;
      if (node) out.set(formatRef(r).toLowerCase(), shapeIssue(node));
    });
  }));
  return out;
}

async function fetchTrackingIssue(ref) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id number title url state stateReason body updatedAt
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        subIssues(first: 100) { nodes { number repository { owner { login } name } } }
      }
    }
  }`, { owner: ref.owner, repo: ref.repo, number: ref.number });
  const root = data?.repository?.issue;
  if (!root) throw new Error(`${formatRef(ref)} was not found, or your GitHub login cannot see it.`);
  // Body links keep the author's order; sub-issues not mentioned there follow.
  const refs = linkedIssueRefs(root.body, ref);
  const known = new Set(refs.map(r => formatRef(r).toLowerCase()));
  const subIssueKeys = [];
  for (const sub of root.subIssues?.nodes || []) {
    const r = { kind: 'issue', owner: sub.repository.owner.login, repo: sub.repository.name, number: sub.number };
    const key = formatRef(r).toLowerCase();
    subIssueKeys.push(key);
    if (!known.has(key)) { known.add(key); refs.push(r); }
  }
  const issues = await fetchIssues(refs);
  const items = refs.map(r => issues.get(formatRef(r).toLowerCase())).filter(Boolean);
  const [issueFields] = await Promise.all([phaseFieldsFor(ref.owner, items), addReviewChanges(items.flatMap(i => i.pullRequests))]);
  return {
    kind: 'issue',
    ref: formatRef(ref),
    title: root.title,
    url: root.url,
    state: root.state,
    repo: root.repository.nameWithOwner,
    number: root.number,
    id: root.id,
    // The project's plan: the tracking issue's description, edited in place.
    plan: { body: root.body || '', updatedAt: root.updatedAt, editable: true },
    items,
    summary: summarize(items),
    // Phases are worked out in the renderer (public/github-phases.js), from
    // one of these fields or from milestones.
    issueFields,
    // A /wayfinder map: its tickets are the sub-issues, in this order
    // ("owner/repo#n" in lower case), and the frontier is worked out from them
    // (public/github-wayfinder.js).
    wayfinder: (root.labels?.nodes || []).some(l => l.name === WAYFINDER_MAP_LABEL) ? { tickets: subIssueKeys } : null,
  };
}

async function fetchProject(ref) {
  const owner = ref.ownerType === 'organization' ? 'organization' : 'user';
  const items = [];
  let cursor = null;
  let project = null;
  do {
    const data = await graphql(`query($login: String!, $number: Int!, $after: String, $me: String) {
      ${owner}(login: $login) {
        projectV2(number: $number) {
          id title url closed shortDescription readme updatedAt
          items(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
              content {
                __typename
                ... on Issue { ${ISSUE_FIELDS} }
                ... on PullRequest { ${PR_FIELDS} }
                ... on DraftIssue { title updatedAt }
              }
            }
          }
        }
      }
    }`, { login: ref.owner, number: ref.number, after: cursor, me: await ghLogin() });
    project = data?.[owner]?.projectV2;
    if (!project) throw new Error(`Project ${ref.number} of ${ref.owner} was not found, or your GitHub login cannot see it.`);
    for (const node of project.items.nodes) {
      const content = node.content;
      if (!content) continue;
      let item;
      if (content.__typename === 'Issue') item = shapeIssue(content);
      else if (content.__typename === 'PullRequest') {
        const pr = shapePr(content, 'linked');
        item = { repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, state: pr.state === 'OPEN' ? 'OPEN' : 'CLOSED', stateReason: pr.state === 'MERGED' ? 'COMPLETED' : null, updatedAt: pr.updatedAt, assignees: [], pullRequests: [pr], isPullRequest: true };
        item.status = itemStatus(item);
      } else {
        item = { repo: '', number: null, title: content.title, url: null, state: 'OPEN', stateReason: null, updatedAt: content.updatedAt, assignees: [], pullRequests: [], isDraft: true, status: 'todo' };
      }
      item.projectStatus = node.status?.name || null;
      items.push(item);
    }
    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);
  await addReviewChanges(items.flatMap(i => i.pullRequests));
  return {
    kind: 'project', ref: formatRef(ref), id: project.id, title: project.title, url: project.url, state: project.closed ? 'CLOSED' : 'OPEN',
    // A Project's README is its plan; the short description heads it.
    plan: { body: project.readme || project.shortDescription || '', updatedAt: project.updatedAt, editable: true },
    items, summary: summarize(items), issueFields: await phaseFieldsFor(ref.owner, items),
  };
}

const cache = new Map(); // ref text → { at, promise }

/** The tracked work behind one reference, from cache unless `force`. */
function getTracker(refText, { force = false } = {}) {
  const ref = parseRef(refText);
  if (!ref) return Promise.resolve({ error: `Not a GitHub issue or project reference: ${refText}` });
  const key = formatRef(ref).toLowerCase();
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = (ref.kind === 'issue' ? fetchTrackingIssue(ref) : fetchProject(ref))
    .then(data => ({ ok: true, fetchedAt: new Date().toISOString(), ...data }))
    .catch(err => {
      cache.delete(key);
      return { error: err.message || String(err) };
    });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// --- Release status: which tags a merged PR has shipped in ---
//
// A PR is released once its merge commit is in a tag (`git tag --contains`).
// What a tag means comes from the repo's release.toml (mls): "tagged" repos
// deploy production on every tag and staging from main; "staged" repos
// publish a tag to an internal track and promote it target by target, which
// the GitHub Release body records in its Targets table. Containment is asked
// of GitHub (Ref.compare), batched per repo and remembered for good: a tag
// that contains a commit always will.

const RELEASE_STAGES = ['internal', 'beta', 'production'];
const RELEASE_BATCH = 50;

/** The mls release model ("tagged" or "staged") from release.toml; null without one. */
function releaseModel(toml) {
  const m = String(toml || '').match(/^\s*model\s*=\s*"([\w-]+)"/m);
  return m ? m[1] : null;
}

/**
 * The Targets table of an mls Release body: { target: { stage: rollout % } }
 * for the stages each target reached ("✅" is 100, "✅ 50%" a rollout).
 * Null when the body has no such table.
 */
function parseReleaseTargets(body) {
  const lines = String(body || '').split('\n');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const start = lines.findIndex(l => /^\s*\|/.test(l) && /^target$/i.test(cells(l)[0]));
  if (start < 0) return null;
  const stages = cells(lines[start]).slice(1).map(s => s.toLowerCase());
  const targets = {};
  for (const line of lines.slice(start + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const [name, ...marks] = cells(line);
    if (!name || name.startsWith('**')) continue; // the totals row
    targets[name] = {};
    marks.forEach((mark, i) => {
      if (!mark.includes('✅') || !stages[i]) return;
      const pct = mark.match(/(\d+)\s*%/);
      targets[name][stages[i]] = pct ? Number(pct[1]) : 100;
    });
  }
  return targets;
}

/**
 * Where a merge commit stands in a repo's tags. `info` is { model, tags }
 * with tags oldest first ({ name, date, targets }); `check(tagName)` answers
 * whether that tag contains the commit. Null when the repo has no tags.
 */
async function resolveRelease(info, mergedAt, check) {
  const tags = info?.tags || [];
  if (!tags.length) return null;
  const model = info.model || null;
  // A tag's commit descends from the merge, so it is never older than it.
  const since = new Date(mergedAt).getTime();
  const later = tags.filter(t => new Date(t.date).getTime() >= since);
  // The first tag after the merge nearly always has it; ask a few at a time.
  let first = -1;
  for (let i = 0; i < later.length && first < 0; i += 3) {
    const answers = await Promise.all(later.slice(i, i + 3).map(t => check(t.name)));
    if (answers.includes(true)) first = i + answers.indexOf(true);
  }
  if (first < 0) return { state: 'unreleased', model };
  const head = later[first];
  if (model !== 'staged') return { state: 'released', model, stage: 'production', tag: head.name, targets: null };

  // Per target and stage, the earliest tag that reached it and contains the
  // merge; a later tag on a hotfix branch does not.
  const rest = later.slice(first);
  const names = [...new Set(rest.flatMap(t => Object.keys(t.targets || {})))];
  const reached = await Promise.all(names.flatMap(target => RELEASE_STAGES.map(async (stage) => {
    for (const t of rest) {
      const rollout = t.targets?.[target]?.[stage];
      if (rollout !== undefined && (t === head || await check(t.name))) return { stage, target, tag: t.name, rollout };
    }
    return null;
  })));
  const found = reached.filter(Boolean);
  if (!found.length) return { state: 'released', model, stage: null, tag: head.name, targets: null };
  const targets = Object.fromEntries(RELEASE_STAGES.map(s => [s, found.filter(r => r.stage === s).map(({ target, tag, rollout }) => ({ target, tag, rollout }))]));
  const stage = [...RELEASE_STAGES].reverse().find(s => targets[s].length);
  const order = rest.map(t => t.name);
  const tag = targets[stage].map(r => r.tag).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return { state: 'released', model, stage, tag, targets };
}

const releaseInfoCache = new Map(); // "owner/repo" → { at, promise }

/** A repo's release model and tags (oldest first, with their Release's Targets table). */
function repoReleaseInfo(owner, repo, { force = false } = {}) {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = releaseInfoCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = graphql(`query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      toml: object(expression: "HEAD:release.toml") { ... on Blob { text } }
      refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes {
        name target { __typename ... on Commit { committedDate } ... on Tag { target { ... on Commit { committedDate } } } }
      } }
      releases(first: 30, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName description } }
    }
  }`, { owner, repo })
    .then(data => {
      const r = data?.repository;
      if (!r) throw new Error(`${owner}/${repo} was not found.`);
      const tables = new Map((r.releases?.nodes || []).map(n => [n.tagName, parseReleaseTargets(n.description)]));
      const tags = (r.refs?.nodes || []).map(n => ({
        name: n.name,
        date: n.target?.committedDate || n.target?.target?.committedDate || null,
        targets: tables.get(n.name) || null,
      })).filter(t => t.date).sort((a, b) => new Date(a.date) - new Date(b.date));
      return { model: releaseModel(r.toml?.text), tags };
    })
    .catch(err => { releaseInfoCache.delete(key); throw err; });
  releaseInfoCache.set(key, { at: Date.now(), promise });
  return promise;
}

const containsCache = new Map(); // "owner/repo|tag|sha" → Promise<boolean>
const containsQueue = new Map(); // "owner/repo" → [{ tag, sha, resolve, reject }]

/** Whether a tag contains a commit; questions asked in the same tick go out as one query per repo. */
function tagContains(owner, repo, tag, sha) {
  const key = `${owner}/${repo}|${tag}|${sha}`.toLowerCase();
  if (containsCache.has(key)) return containsCache.get(key);
  const promise = new Promise((resolve, reject) => {
    const repoKey = `${owner}/${repo}`;
    if (!containsQueue.has(repoKey)) {
      containsQueue.set(repoKey, []);
      setTimeout(() => flushContains(owner, repo), 0);
    }
    containsQueue.get(repoKey).push({ tag, sha, resolve, reject });
  });
  promise.catch(() => containsCache.delete(key)); // ask again next time
  containsCache.set(key, promise);
  return promise;
}

async function flushContains(owner, repo) {
  const queue = containsQueue.get(`${owner}/${repo}`) || [];
  containsQueue.delete(`${owner}/${repo}`);
  for (let i = 0; i < queue.length; i += RELEASE_BATCH) {
    const batch = queue.slice(i, i + RELEASE_BATCH);
    const query = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {\n${batch.map((q, j) =>
      `  c${j}: ref(qualifiedName: ${JSON.stringify(`refs/tags/${q.tag}`)}) { compare(headRef: ${JSON.stringify(q.sha)}) { status } }`).join('\n')}\n} }`;
    try {
      const data = await graphql(query, { owner, repo });
      // BEHIND: the commit is behind the tag, so the tag contains it.
      batch.forEach((q, j) => q.resolve(['BEHIND', 'IDENTICAL'].includes(data?.repository?.[`c${j}`]?.compare?.status)));
    } catch (err) {
      batch.forEach(q => q.reject(err));
    }
  }
}

/**
 * Release status of merged PRs ({ repo: "owner/name", number, sha, mergedAt }),
 * keyed "owner/name#number". A repo that cannot be read leaves its PRs out.
 */
async function getReleaseStatus(prs, { force = false } = {}) {
  const statuses = {};
  // One read of each repo's tags, also when several PRs come from it.
  const infos = new Map();
  await Promise.all((prs || []).filter(p => p?.sha && p.mergedAt && /^[^/]+\/[^/]+$/.test(p.repo || '')).map(async (p) => {
    const [owner, repo] = p.repo.split('/');
    try {
      const key = p.repo.toLowerCase();
      if (!infos.has(key)) infos.set(key, repoReleaseInfo(owner, repo, { force }));
      const info = await infos.get(key);
      const status = await resolveRelease(info, p.mergedAt, (tag) => tagContains(owner, repo, tag, p.sha));
      if (status) statuses[`${p.repo}#${p.number}`] = status;
    } catch {}
  }));
  return { statuses };
}

// --- Your own review: a marked comment review (public/github-my-review.js) ---

const reviewChangeCache = new Map(); // "owner/repo#n|reviewed|head" → Promise<number|null>

/**
 * How many of a PR's files differ between the commit you reviewed and the
 * head: 0 after a rebase that did not touch them. Null when unknown.
 */
function reviewChangedFiles(owner, repo, number, sha, head) {
  const key = `${owner}/${repo}#${number}|${sha}|${head}`.toLowerCase();
  if (reviewChangeCache.has(key)) return reviewChangeCache.get(key);
  const promise = (async () => {
    const files = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) { files(first: 100) { nodes { path } } } }
    }`, { owner, repo, number });
    const paths = (files?.repository?.pullRequest?.files?.nodes || []).map(n => n.path);
    if (!paths.length) return 0;
    // A file missing at one end comes back null (with an error GitHub sends alongside the data).
    const pick = paths.map((p, i) => `f${i}: file(path: ${JSON.stringify(p)}) { oid }`).join(' ');
    const data = await graphql(`query($owner: String!, $repo: String!, $a: GitObjectID!, $b: GitObjectID!) {
      repository(owner: $owner, name: $repo) { a: object(oid: $a) { ... on Commit { ${pick} } } b: object(oid: $b) { ... on Commit { ${pick} } } }
    }`, { owner, repo, a: sha, b: head });
    const a = data?.repository?.a;
    const b = data?.repository?.b;
    if (!a || !b) return null;
    return paths.filter((_, i) => (a[`f${i}`]?.oid || null) !== (b[`f${i}`]?.oid || null)).length;
  })().catch(() => { reviewChangeCache.delete(key); return null; });
  reviewChangeCache.set(key, promise);
  return promise;
}

/** Fill in myReview.changedFiles on open PRs whose head moved since your review. */
async function addReviewChanges(prs) {
  await Promise.all((prs || []).map(async (pr) => {
    const mine = pr?.myReview;
    if (!mine || pr.state !== 'OPEN' || !pr.headOid || mine.sha === pr.headOid) return;
    const [owner, repo] = String(pr.repo || '').split('/');
    if (owner && repo) mine.changedFiles = await reviewChangedFiles(owner, repo, pr.number, mine.sha, pr.headOid);
  }));
}

/**
 * Mark a PR reviewed by you: a comment review on the commit the panel showed.
 * GitHub does not let you approve your own PR; this works on any PR.
 */
async function markReviewed(owner, repo, number, headOid) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id headRefOid } }
  }`, { owner, repo, number });
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error(`${owner}/${repo}#${number} was not found.`);
  if (headOid && pr.headRefOid !== headOid) throw new Error('New commits came in after this panel loaded. Refresh and look at those first.');
  await graphql(`mutation($id: ID!, $oid: GitObjectID!, $body: String!) {
    addPullRequestReview(input: { pullRequestId: $id, commitOID: $oid, event: COMMENT, body: $body }) { pullRequestReview { id } }
  }`, { id: pr.id, oid: pr.headRefOid, body: reviewMarkBody(pr.headRefOid) });
  cache.clear();
  return { ok: true };
}

// --- Review requests ---

/**
 * Who can be asked to review, in menu order: people who reviewed before (to
 * ask again), GitHub's suggestions, then everyone else who can be assigned.
 * The author, you, bots and people already asked are left out.
 */
function reviewCandidates({ users = [], suggested = [], author, me, requested = [], reviewed = [] }) {
  const skip = new Set([author, me, ...requested].filter(Boolean).map(l => l.toLowerCase()));
  const names = new Map([...users, ...suggested].map(u => [u.login.toLowerCase(), u.name || null]));
  const out = [];
  const add = (login, group) => {
    const key = login.toLowerCase();
    if (skip.has(key) || isIgnoredReviewer({ login })) return;
    skip.add(key);
    out.push({ login, name: names.get(key) || null, group });
  };
  reviewed.forEach(l => add(l, 'reviewed'));
  suggested.forEach(u => add(u.login, 'suggested'));
  users.forEach(u => add(u.login, 'other'));
  return out;
}

/** The reviewer menu for a PR (see reviewCandidates). */
async function getReviewCandidates(owner, repo, number) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      assignableUsers(first: 100) { nodes { login name } }
      pullRequest(number: $number) {
        author { login }
        suggestedReviewers { reviewer { login name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        latestOpinionatedReviews(first: 20) { nodes { author { login } } }
      }
    }
  }`, { owner, repo, number });
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error(`${owner}/${repo}#${number} was not found.`);
  return {
    candidates: reviewCandidates({
      users: data.repository.assignableUsers?.nodes || [],
      suggested: (pr.suggestedReviewers || []).map(s => s.reviewer).filter(Boolean),
      author: pr.author?.login, me: await ghLogin(),
      requested: (pr.reviewRequests?.nodes || []).map(n => n.requestedReviewer?.login).filter(Boolean),
      reviewed: (pr.latestOpinionatedReviews?.nodes || []).map(n => n.author?.login).filter(Boolean),
    }),
  };
}

/** Ask someone to review a PR, or withdraw the request. */
async function setReviewRequest(owner, repo, number, login, on) {
  if (!/^[\w-]+$/.test(String(login || ''))) throw new Error('Not a GitHub login.');
  await rest(on ? 'POST' : 'DELETE', `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { reviewers: [login] });
  cache.clear();
  return { ok: true };
}

// --- Pull request and issue detail (the side panel) ---

const AUTOREBASE_LABEL = 'autorebase:opt-in';
const AUTOREBASE_FAILED_LABEL = 'autorebase:non-rebaseable';

const COMMENT_FIELDS = 'author { login } body createdAt url';

/** Everything the review panel shows for one PR, read fresh (no cache). */
async function getPullRequest(owner, repo, number) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!, $me: String) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner squashMergeAllowed rebaseMergeAllowed mergeCommitAllowed autoMergeAllowed defaultBranchRef { name }
      autorebase: label(name: "${AUTOREBASE_LABEL}") { id }
      pullRequest(number: $number) {
        id number title url state isDraft merged mergedAt mergeCommit { oid } body createdAt updatedAt
        author { login }
        headRefName baseRefName headRefOid
        mergeable mergeStateStatus reviewDecision
        autoMergeRequest { enabledBy { login } mergeMethod enabledAt }
        additions deletions changedFiles
        labels(first: 30) { nodes { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } } }
        latestOpinionatedReviews(first: 20) { nodes { author { __typename login } state submittedAt url } }
        comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
        reviews(last: 30) { nodes { author { login } state body submittedAt url } }
        mine: reviews(last: 20, author: $me) { nodes { state body submittedAt commit { oid } } }
        reviewThreads(last: 50) { nodes { isResolved isOutdated path line comments(first: 20) { nodes { ${COMMENT_FIELDS} } } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
        } } } } } }
      }
    }
  }`, { owner, repo, number, me: await ghLogin() });
  const r = data?.repository;
  const pr = r?.pullRequest;
  if (!pr) throw new Error(`${owner}/${repo}#${number} was not found, or your GitHub login cannot see it.`);
  const commit = pr.commits?.nodes?.[0]?.commit;
  const labels = (pr.labels?.nodes || []).map(l => l.name);
  const mine = { repo: r.nameWithOwner, number: pr.number, state: pr.state, headOid: pr.headRefOid, myReview: latestMyReview(pr.mine?.nodes) };
  await addReviewChanges([mine]);
  return {
    kind: 'pr',
    id: pr.id, repo: r.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
    state: pr.state, isDraft: pr.isDraft, merged: pr.merged, mergedAt: pr.mergedAt, mergeSha: pr.mergeCommit?.oid || null,
    body: pr.body || '', author: pr.author?.login || 'ghost', createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    headRef: pr.headRefName, baseRef: pr.baseRefName, headOid: pr.headRefOid,
    myReview: mine.myReview,
    defaultBranch: r.defaultBranchRef?.name || null,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision,
    additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    labels,
    autorebase: {
      available: !!r.autorebase?.id,
      on: labels.includes(AUTOREBASE_LABEL),
      failed: labels.includes(AUTOREBASE_FAILED_LABEL),
      label: AUTOREBASE_LABEL,
    },
    mergeMethods: [
      r.squashMergeAllowed && 'SQUASH', r.rebaseMergeAllowed && 'REBASE', r.mergeCommitAllowed && 'MERGE',
    ].filter(Boolean),
    // GitHub merges it by itself once the requirements are met (checks, reviews).
    autoMerge: {
      allowed: !!r.autoMergeAllowed,
      on: !!pr.autoMergeRequest,
      method: pr.autoMergeRequest?.mergeMethod || null,
      by: pr.autoMergeRequest?.enabledBy?.login || null,
      at: pr.autoMergeRequest?.enabledAt || null,
    },
    requested: (pr.reviewRequests?.nodes || []).map(n => n.requestedReviewer)
      .filter(r => r && !isIgnoredReviewer(r.__typename === 'Team' ? { login: r.name, __typename: 'Team' } : r))
      .map(r => r.login || r.name),
    reviews: (pr.latestOpinionatedReviews?.nodes || []).map(n => ({ author: n.author?.login || 'ghost', state: n.state, at: n.submittedAt, url: n.url, ignored: isIgnoredReviewer(n.author) })),
    humanReview: humanReview(pr.latestOpinionatedReviews?.nodes || []),
    comments: [
      ...(pr.comments?.nodes || []).map(c => ({ kind: 'comment', author: c.author?.login || 'ghost', body: c.body, at: c.createdAt, url: c.url })),
      ...(pr.reviews?.nodes || []).filter(rv => rv.body).map(rv => ({ kind: 'review', state: rv.state, author: rv.author?.login || 'ghost', body: rv.body, at: rv.submittedAt, url: rv.url })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at)),
    threads: (pr.reviewThreads?.nodes || []).map(t => ({
      path: t.path, line: t.line, resolved: t.isResolved, outdated: t.isOutdated,
      comments: (t.comments?.nodes || []).map(c => ({ author: c.author?.login || 'ghost', body: c.body, at: c.createdAt, url: c.url })),
    })),
    checks: {
      state: commit?.statusCheckRollup?.state || null,
      runs: (commit?.statusCheckRollup?.contexts?.nodes || []).map(n => n.__typename === 'CheckRun'
        ? { name: n.name, status: n.status, conclusion: n.conclusion, url: n.detailsUrl, required: !!n.isRequired }
        : { name: n.context, status: n.state === 'PENDING' || n.state === 'EXPECTED' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: n.state === 'SUCCESS' ? 'SUCCESS' : n.state === 'PENDING' || n.state === 'EXPECTED' ? null : 'FAILURE', url: n.targetUrl, required: !!n.isRequired }),
    },
  };
}

/** An issue with its description and comments, for items without a PR. */
async function getIssue(owner, repo, number) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner
      issue(number: $number) {
        number title url state stateReason body createdAt author { login }
        comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
      }
    }
  }`, { owner, repo, number });
  const issue = data?.repository?.issue;
  if (!issue) throw new Error(`${owner}/${repo}#${number} was not found, or your GitHub login cannot see it.`);
  return {
    kind: 'issue', repo: data.repository.nameWithOwner, number: issue.number, title: issue.title, url: issue.url,
    state: issue.state, stateReason: issue.stateReason, body: issue.body || '', author: issue.author?.login || 'ghost', createdAt: issue.createdAt,
    comments: (issue.comments?.nodes || []).map(c => ({ kind: 'comment', author: c.author?.login || 'ghost', body: c.body, at: c.createdAt, url: c.url })),
  };
}

/**
 * The state and title of issues and PRs by `owner/repo#n` (either kind), keyed
 * by that text in lower case: { state: OPEN|CLOSED|MERGED, title, isPullRequest }.
 * Refs GitHub does not find are left out.
 */
async function getRefStates(keys) {
  const refs = [...new Set(keys.map(k => String(k).toLowerCase()))].map(k => ({ key: k, ref: parseRef(k) })).filter(r => r.ref?.kind === 'issue');
  const out = {};
  for (let i = 0; i < refs.length; i += ITEM_BATCH) {
    const batch = refs.slice(i, i + ITEM_BATCH);
    const data = await graphql(`query {\n${batch.map(({ ref }, j) =>
      `  r${j}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) { issueOrPullRequest(number: ${ref.number}) { __typename ... on Issue { state title } ... on PullRequest { state title } } }`
    ).join('\n')}\n}`);
    batch.forEach(({ key }, j) => {
      const node = data?.[`r${j}`]?.issueOrPullRequest;
      if (node) out[key] = { state: node.state, title: node.title, isPullRequest: node.__typename === 'PullRequest' };
    });
  }
  return out;
}

/** Turn auto-rebase on or off for a PR: the autorebase:opt-in label. */
async function setAutorebase(owner, repo, number, on) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { label(name: "${AUTOREBASE_LABEL}") { id } pullRequest(number: $number) { id } }
  }`, { owner, repo, number });
  const labelId = data?.repository?.label?.id;
  const prId = data?.repository?.pullRequest?.id;
  if (!labelId) throw new Error(`${owner}/${repo} has no "${AUTOREBASE_LABEL}" label.`);
  if (!prId) throw new Error(`${owner}/${repo}#${number} was not found.`);
  const mutation = on ? 'addLabelsToLabelable' : 'removeLabelsFromLabelable';
  await graphql(`mutation($id: ID!, $labels: [ID!]!) { ${mutation}(input: { labelableId: $id, labelIds: $labels }) { clientMutationId } }`, { id: prId, labels: [labelId] });
  return { ok: true };
}

const MERGE_METHODS = new Set(['SQUASH', 'REBASE', 'MERGE']);

/**
 * Merge a PR at the commit the user reviewed: GitHub refuses when the head
 * moved since (expectedHeadOid), so a push after the panel loaded is never
 * merged unseen.
 */
async function mergePullRequest(owner, repo, number, { method, expectedHeadOid }) {
  if (!MERGE_METHODS.has(method)) throw new Error(`Unknown merge method: ${method}`);
  if (!expectedHeadOid) throw new Error('The reviewed commit is unknown; refresh and try again.');
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id headRefOid } }
  }`, { owner, repo, number });
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error(`${owner}/${repo}#${number} was not found.`);
  if (pr.headRefOid !== expectedHeadOid) throw new Error('New commits were pushed since you loaded this PR. Look at them first, then merge.');
  const res = await graphql(`mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID!) {
    mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { pullRequest { merged mergedAt url } }
  }`, { id: pr.id, method, oid: expectedHeadOid });
  // Every tracker that lists this PR is stale now.
  cache.clear();
  return { ok: true, merged: !!res?.mergePullRequest?.pullRequest?.merged };
}

/** Turn GitHub's auto-merge on (with a merge method) or off for a PR. */
async function setAutoMerge(owner, repo, number, { on, method }) {
  if (on && !MERGE_METHODS.has(method)) throw new Error(`Unknown merge method: ${method}`);
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } }
  }`, { owner, repo, number });
  const id = data?.repository?.pullRequest?.id;
  if (!id) throw new Error(`${owner}/${repo}#${number} was not found.`);
  if (on) {
    await graphql(`mutation($id: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id } }
    }`, { id, method });
  } else {
    await graphql(`mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id } } }`, { id });
  }
  return { ok: true };
}

/** A file's text at a commit, for the whole-file view of a PR's diff. */
async function getFileContent(owner, repo, filePath, ref) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  const file = await rest('GET', `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(file) || file?.type !== 'file') throw new Error(`${filePath} is not a file at ${String(ref).slice(0, 7)}.`);
  if (file.encoding !== 'base64' || !file.content) throw new Error('GitHub does not return this file\'s text (over 1 MB, or binary). Open it on GitHub.');
  return { ok: true, text: Buffer.from(file.content, 'base64').toString('utf8') };
}

// --- Writing back: the project's todos and plan live on GitHub ---

async function rest(method, apiPath, body) {
  const token = await ghToken();
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Switchboard', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message ? `GitHub: ${json.message}` : `GitHub answered ${res.status}`);
  return json;
}

async function issueNode(owner, repo, number) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) { id issue(number: $number) { id title body updatedAt state } }
  }`, { owner, repo, number });
  const issue = data?.repository?.issue;
  if (!issue) throw new Error(`${owner}/${repo}#${number} was not found.`);
  return { ...issue, repositoryId: data.repository.id };
}

/** Tick (close as completed) or untick (reopen) a todo. */
async function setIssueClosed(owner, repo, number, closed) {
  const { id } = await issueNode(owner, repo, number);
  if (closed) await graphql('mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { state } } }', { id });
  else await graphql('mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { issue { state } } }', { id });
  cache.clear();
  return { ok: true };
}

async function renameIssue(owner, repo, number, title) {
  const text = String(title || '').trim();
  if (!text) throw new Error('A todo needs a title.');
  const { id } = await issueNode(owner, repo, number);
  await graphql('mutation($id: ID!, $title: String!) { updateIssue(input: { id: $id, title: $title }) { issue { title } } }', { id, title: text });
  cache.clear();
  return { ok: true };
}

/**
 * A new todo: an issue in `repo`, added as a sub-issue of the tracking issue
 * so the plan lists it, and given a milestone (phase) when one is named.
 */
async function createTodo(trackerRefText, { repo: repoFull, title, milestone }) {
  const tracker = parseRef(trackerRefText);
  const text = String(title || '').trim();
  if (!text) throw new Error('A todo needs a title.');
  const [owner, repo] = String(repoFull || '').split('/');
  if (!owner || !repo) throw new Error('Pick the repository the todo belongs in.');
  const created = await rest('POST', `/repos/${owner}/${repo}/issues`, { title: text });
  if (tracker?.kind === 'issue') {
    const parent = await issueNode(tracker.owner, tracker.repo, tracker.number);
    await graphql('mutation($parent: ID!, $child: ID!) { addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } } }',
      { parent: parent.id, child: created.node_id });
  } else if (tracker?.kind === 'project') {
    const project = await fetchProjectId(tracker);
    await graphql('mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }',
      { project, content: created.node_id });
  }
  if (milestone) await setIssueMilestone(owner, repo, created.number, milestone);
  cache.clear();
  return { ok: true, number: created.number, url: created.html_url };
}

async function fetchProjectId(ref) {
  const owner = ref.ownerType === 'organization' ? 'organization' : 'user';
  const data = await graphql(`query($login: String!, $number: Int!) { ${owner}(login: $login) { projectV2(number: $number) { id } } }`, { login: ref.owner, number: ref.number });
  const id = data?.[owner]?.projectV2?.id;
  if (!id) throw new Error('Project not found.');
  return id;
}

/**
 * Save the plan: the tracking issue's description, or a Project's README.
 * `expectedUpdatedAt` is when the text being edited was read; if the plan
 * changed on GitHub since, nothing is written, so no one's edit is lost.
 */
async function updatePlan(trackerRefText, body, expectedUpdatedAt) {
  const ref = parseRef(trackerRefText);
  if (!ref) throw new Error('Unknown plan reference.');
  if (ref.kind === 'issue') {
    const issue = await issueNode(ref.owner, ref.repo, ref.number);
    if (expectedUpdatedAt && issue.updatedAt !== expectedUpdatedAt && issue.body !== body) {
      throw new Error('The plan was changed on GitHub since you opened it. Reload it, then make your edit again.');
    }
    await graphql('mutation($id: ID!, $body: String!) { updateIssue(input: { id: $id, body: $body }) { issue { updatedAt } } }', { id: issue.id, body: String(body) });
  } else {
    const id = await fetchProjectId(ref);
    await graphql('mutation($id: ID!, $readme: String!) { updateProjectV2(input: { projectId: $id, readme: $readme }) { projectV2 { updatedAt } } }', { id, readme: String(body) });
  }
  cache.clear();
  return { ok: true };
}

async function repoMilestones(owner, repo) {
  const list = [];
  for (let page = 1; page < 10; page++) {
    const batch = await rest('GET', `/repos/${owner}/${repo}/milestones?state=all&per_page=100&page=${page}`);
    list.push(...batch);
    if (batch.length < 100) break;
  }
  return list;
}

/** Put an issue in the phase (milestone) titled `title` of its repo, creating it there if needed; null clears it. */
async function setIssueMilestone(owner, repo, number, title) {
  let milestoneNumber = null;
  if (title) {
    const want = String(title).trim();
    const existing = (await repoMilestones(owner, repo)).find(m => m.title.trim().toLowerCase() === want.toLowerCase());
    milestoneNumber = existing ? existing.number : (await rest('POST', `/repos/${owner}/${repo}/milestones`, { title: want })).number;
  }
  await rest('PATCH', `/repos/${owner}/${repo}/issues/${number}`, { milestone: milestoneNumber });
  cache.clear();
  return { ok: true };
}

/**
 * Phases for a plan that has none yet, from one column of the issue table in
 * its description ("Wave" in the CityRow plan). Returns what it would do;
 * with `apply`, creates the milestones per repo and assigns every issue.
 * A number becomes "<Column> <n>"; other values lose a trailing "(…)" note.
 */
function milestonePlanFromTable(body, column) {
  const lines = String(body || '').split('\n');
  const plan = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const header = splitRow(lines[i]).map(h => h.trim().toLowerCase());
    const col = header.indexOf(String(column).trim().toLowerCase());
    if (col === -1) continue;
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitRow(lines[j]);
      const refs = linkedIssueRefs(cells.join(' | '));
      const raw = (cells[col] || '').trim();
      if (!refs.length || !raw || raw === '-') continue;
      const value = raw.replace(/\s*\(.*\)\s*$/, '').trim();
      const title = /^\d+$/.test(value) ? `${column.trim()} ${value}` : value.charAt(0).toUpperCase() + value.slice(1);
      plan.push({ ref: formatRef(refs[0]), title });
    }
  }
  return plan;
}

// A table row's cells, honouring escaped pipes ("WR\|NOHRD").
function splitRow(line) {
  const cells = [];
  let cur = '';
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cur += '|'; i++; continue; }
    if (text[i] === '|') { cells.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  cells.push(cur);
  return cells;
}

async function seedMilestones(trackerRefText, column, { apply = false } = {}) {
  const ref = parseRef(trackerRefText);
  if (ref?.kind !== 'issue') throw new Error('Phases can be made from a tracking issue\'s table only.');
  const issue = await issueNode(ref.owner, ref.repo, ref.number);
  const plan = milestonePlanFromTable(issue.body, column);
  if (!plan.length) throw new Error(`No issue table with a "${column}" column found in the plan.`);
  if (!apply) return { ok: true, plan };
  // One milestone list per repo, created on first need.
  const byRepo = new Map();
  for (const entry of plan) {
    const t = parseRef(entry.ref);
    const key = `${t.owner}/${t.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, await repoMilestones(t.owner, t.repo));
    const list = byRepo.get(key);
    let m = list.find(x => x.title.trim().toLowerCase() === entry.title.toLowerCase());
    if (!m) { m = await rest('POST', `/repos/${t.owner}/${t.repo}/milestones`, { title: entry.title }); list.push(m); }
    await rest('PATCH', `/repos/${t.owner}/${t.repo}/issues/${t.number}`, { milestone: m.number });
  }
  cache.clear();
  return { ok: true, plan, applied: plan.length };
}

/**
 * Put an issue in a phase held by a field: an organisation issue field
 * (`key` is its name) or a Project field (`key` is "projectId|fieldId"). A
 * single-select takes the option with that name, text and number fields the
 * value itself. null clears it. An issue that is not on the Project yet is
 * added to it first.
 */
async function setIssueField(owner, repo, number, key, value) {
  const def = await findFieldDef(owner, key);
  if (!def) throw new Error(`No field "${key}" to put the phase in.`);
  const clear = value === null || value === undefined || value === '';
  let option = null;
  if (!clear && def.type === 'single_select') {
    option = def.options.find(o => o.name.toLowerCase() === String(value).trim().toLowerCase());
    if (!option) throw new Error(`"${value}" is not an option of ${def.name}. Add it to the field on GitHub first.`);
  }
  const issue = await issueNode(owner, repo, number);

  if (def.scope === 'project') {
    const cards = await graphql(`query($id: ID!) { node(id: $id) { ... on Issue { projectItems(first: 20) { nodes { id project { id } } } } } }`, { id: issue.id });
    let itemId = (cards?.node?.projectItems?.nodes || []).find(n => n.project?.id === def.projectId)?.id;
    if (!itemId && clear) return { ok: true };
    if (!itemId) {
      const added = await graphql('mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }',
        { project: def.projectId, content: issue.id });
      itemId = added?.addProjectV2ItemById?.item?.id;
    }
    if (clear) {
      await graphql('mutation($project: ID!, $item: ID!, $field: ID!) { clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { clientMutationId } }',
        { project: def.projectId, item: itemId, field: def.id });
    } else {
      const fieldValue = def.type === 'single_select' ? { singleSelectOptionId: option.id }
        : def.type === 'number' ? { number: Number(value) } : { text: String(value) };
      await graphql('mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { clientMutationId } }',
        { project: def.projectId, item: itemId, field: def.id, value: fieldValue });
    }
    cache.clear();
    return { ok: true };
  }

  const entry = { fieldId: def.id };
  if (clear) entry.delete = true;
  else if (def.type === 'single_select') entry.singleSelectOptionId = option.id;
  else if (def.type === 'number') entry.numberValue = Number(value);
  else if (def.type === 'text') entry.textValue = String(value);
  else throw new Error(`${def.name} cannot hold a phase.`);
  await graphql('mutation($id: ID!, $fields: [IssueFieldCreateOrUpdateInput!]!) { setIssueFieldValue(input: { issueId: $id, issueFields: $fields }) { clientMutationId } }',
    { id: issue.id, fields: [entry] });
  cache.clear();
  return { ok: true };
}

/**
 * Fill an issue field from a column of the plan's issue table. Values are
 * matched to the field's options by name, with or without the column name
 * ("0" or "Wave 0" both find an option "Wave 0"). Returns what it would do,
 * and what matched no option; with `apply`, sets the values.
 */
async function seedPhaseField(trackerRefText, column, fieldKey, { apply = false } = {}) {
  const ref = parseRef(trackerRefText);
  if (ref?.kind !== 'issue') throw new Error('Phases can be filled from a tracking issue\'s table only.');
  const def = await findFieldDef(ref.owner, fieldKey);
  if (!def) throw new Error(`No field "${fieldKey}" to put the phases in.`);
  const issue = await issueNode(ref.owner, ref.repo, ref.number);
  const rows = milestonePlanFromTable(issue.body, column);
  if (!rows.length) throw new Error(`No issue table with a "${column}" column found in the plan.`);
  const strip = (t) => t.toLowerCase().replace(new RegExp('^' + String(column).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+'), '').trim();
  const plan = [];
  const unmatched = new Set();
  for (const row of rows) {
    let value = row.title;
    if (def.type === 'single_select') {
      const option = def.options.find(o => o.name.toLowerCase() === row.title.toLowerCase() || strip(o.name) === strip(row.title));
      if (!option) { unmatched.add(row.title); continue; }
      value = option.name;
    } else if (def.type === 'number') {
      const n = Number(strip(row.title));
      if (!Number.isFinite(n)) { unmatched.add(row.title); continue; }
      value = n;
    }
    plan.push({ ref: row.ref, title: String(value), value });
  }
  if (!apply) return { ok: true, plan, unmatched: [...unmatched] };
  for (const entry of plan) {
    const t = parseRef(entry.ref);
    await setIssueField(t.owner, t.repo, t.number, def.key, entry.value);
  }
  cache.clear();
  return { ok: true, plan, unmatched: [...unmatched], applied: plan.length };
}

// --- Local checkouts of the plan's repositories ---

/** Clone `owner/repo` into `parentDir/<repo>` with gh, which uses the user's login. */
function cloneRepo(owner, repo, parentDir) {
  const dest = path.join(parentDir, repo);
  if (fs.existsSync(dest)) return Promise.reject(new Error(`${dest} already exists.`));
  const gh = ghCandidates()[ghCandidates().length > 1 ? 1 : 0];
  return new Promise((resolve, reject) => {
    execFile(gh, ['repo', 'clone', `${owner}/${repo}`, dest], { timeout: 10 * 60 * 1000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve({ ok: true, path: dest });
    });
  });
}

/**
 * The files a PR changes, with their patches, for the review view. GitHub
 * leaves `patch` out for binary and very large files; those say so instead.
 */
async function getPullRequestFiles(owner, repo, number) {
  const files = [];
  // GitHub lists at most 3000 files, 100 per page.
  for (let page = 1; page <= 30; page++) {
    const batch = await rest('GET', `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    for (const f of batch) {
      files.push({
        path: f.filename,
        oldPath: f.previous_filename || null,
        status: { removed: 'deleted', renamed: 'renamed', added: 'added', copied: 'added' }[f.status] || 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
        patch: typeof f.patch === 'string' ? f.patch : null,
        url: f.blob_url || null,
      });
    }
    if (batch.length < 100) break;
  }
  // Comments are made against the head commit the files were read at.
  const pr = await rest('GET', `/repos/${owner}/${repo}/pulls/${number}`);
  return { files, headSha: pr?.head?.sha || null };
}

/** Line comments on a PR, oldest first, for the review view. */
async function getReviewComments(owner, repo, number) {
  const comments = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await rest('GET', `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100&page=${page}`);
    for (const c of batch) {
      comments.push({
        id: c.id, inReplyTo: c.in_reply_to_id || null,
        path: c.path, side: c.side || 'RIGHT', line: c.line ?? null, originalLine: c.original_line ?? null,
        body: c.body || '', author: c.user?.login || 'ghost', at: c.created_at, url: c.html_url,
      });
    }
    if (batch.length < 100) break;
  }
  return { comments };
}

/** A comment on one line of the diff: side RIGHT for new and context lines, LEFT for removed ones. */
async function createReviewComment(owner, repo, number, { body, path: filePath, line, side, commitId }) {
  const text = String(body || '').trim();
  if (!text) throw new Error('A comment needs some text.');
  if (!commitId) throw new Error('The PR\'s head commit is unknown; refresh the files and try again.');
  const c = await rest('POST', `/repos/${owner}/${repo}/pulls/${number}/comments`,
    { body: text, commit_id: commitId, path: filePath, line: Number(line), side: side === 'LEFT' ? 'LEFT' : 'RIGHT' });
  return { ok: true, id: c.id };
}

async function replyToReviewComment(owner, repo, number, commentId, body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('A reply needs some text.');
  const c = await rest('POST', `/repos/${owner}/${repo}/pulls/${number}/comments/${Number(commentId)}/replies`, { body: text });
  return { ok: true, id: c.id };
}

/**
 * The GitHub view's two lists: open PRs you opened, and open PRs that ask for
 * your review. Shaped like a tracker's items (one PR each), so the PR panel
 * and its chips work on them unchanged.
 */
async function getMyPullRequests() {
  const data = await graphql(`query($me: String) {
    mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
    review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 50) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
    closedMine: search(query: "is:pr is:closed author:@me archived:false sort:updated-desc", type: ISSUE, first: ${CLOSED_PRS}) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
    closedRequested: search(query: "is:pr is:closed review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: ${CLOSED_PRS}) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
    closedReviewed: search(query: "is:pr is:closed reviewed-by:@me -author:@me archived:false sort:updated-desc", type: ISSUE, first: ${CLOSED_PRS}) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
  }`, { me: await ghLogin() });
  const toItem = (node) => {
    if (!node?.number) return null;
    const pr = shapePr(node, 'linked');
    const item = {
      repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, state: pr.state === 'OPEN' ? 'OPEN' : 'CLOSED', stateReason: null,
      updatedAt: pr.updatedAt, author: node.author?.login || 'ghost', assignees: [],
      pullRequests: [pr], isPullRequest: true,
    };
    item.status = itemStatus(item);
    return item;
  };
  // Merged or closed: yours, and the ones your review was asked for or that
  // you reviewed (a request goes once it is answered), newest first, once each.
  const closed = new Map();
  for (const node of [...(data?.closedMine?.nodes || []), ...(data?.closedRequested?.nodes || []), ...(data?.closedReviewed?.nodes || [])]) {
    const item = toItem(node);
    if (item) closed.set(`${item.repo}#${item.number}`, item);
  }
  const lists = {
    mine: (data?.mine?.nodes || []).map(toItem).filter(Boolean),
    review: (data?.review?.nodes || []).map(toItem).filter(Boolean),
    closed: [...closed.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, CLOSED_PRS),
  };
  await addReviewChanges([...lists.mine, ...lists.review].flatMap(i => i.pullRequests));
  return { ...lists, fetchedAt: new Date().toISOString() };
}

/** Run a GitHub call for the renderer; errors become { error } like the rest of IPC. */
function asResult(promise) {
  return promise.then(v => (v && v.ok !== undefined ? v : { ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = {
  parseRef, formatRef, linkedIssueRefs, itemStatus, summarize, shapeIssue, getTracker, ITEM_STATUSES,
  humanReview, isIgnoredReviewer, getMyPullRequests, getPullRequest, getRefStates, setAutoMerge, getFileContent, getPullRequestFiles, getReviewComments, createReviewComment, replyToReviewComment, getIssue, setAutorebase, mergePullRequest, asResult, AUTOREBASE_LABEL,
  phasesFrom, shapeFieldValues, shapeProjectValues, phaseFieldsFor, issueFieldsOf, setIssueField, seedPhaseField, setIssueClosed, renameIssue, createTodo, updatePlan, setIssueMilestone,
  milestonePlanFromTable, seedMilestones, cloneRepo,
  releaseModel, parseReleaseTargets, resolveRelease, getReleaseStatus, markReviewed,
  reviewCandidates, getReviewCandidates, setReviewRequest,
};
