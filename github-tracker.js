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
  number title url state isDraft reviewDecision updatedAt
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
    pullRequests: [...prs.values()].sort((a, b) => b.number - a.number),
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
    const query = (withProjects) => `query {\n${batch.map((r, j) =>
      `  i${j}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) { issue(number: ${r.number}) { ${ISSUE_FIELDS}${withProjects ? PROJECT_ITEM_FIELDS : ''} } }`
    ).join('\n')}\n}`;
    let data;
    try {
      data = await graphql(query(projectScope));
    } catch (err) {
      if (!projectScope || !isScopeError(err)) throw err;
      projectScope = false; // read without Project fields from now on
      data = await graphql(query(false));
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
        subIssues(first: 100) { nodes { number repository { owner { login } name } } }
      }
    }
  }`, { owner: ref.owner, repo: ref.repo, number: ref.number });
  const root = data?.repository?.issue;
  if (!root) throw new Error(`${formatRef(ref)} was not found, or your GitHub login cannot see it.`);
  // Body links keep the author's order; sub-issues not mentioned there follow.
  const refs = linkedIssueRefs(root.body, ref);
  const known = new Set(refs.map(r => formatRef(r).toLowerCase()));
  for (const sub of root.subIssues?.nodes || []) {
    const r = { kind: 'issue', owner: sub.repository.owner.login, repo: sub.repository.name, number: sub.number };
    const key = formatRef(r).toLowerCase();
    if (!known.has(key)) { known.add(key); refs.push(r); }
  }
  const issues = await fetchIssues(refs);
  const items = refs.map(r => issues.get(formatRef(r).toLowerCase())).filter(Boolean);
  const issueFields = await phaseFieldsFor(ref.owner, items);
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
  };
}

async function fetchProject(ref) {
  const owner = ref.ownerType === 'organization' ? 'organization' : 'user';
  const items = [];
  let cursor = null;
  let project = null;
  do {
    const data = await graphql(`query($login: String!, $number: Int!, $after: String) {
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
    }`, { login: ref.owner, number: ref.number, after: cursor });
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

// --- Pull request and issue detail (the side panel) ---

const AUTOREBASE_LABEL = 'autorebase:opt-in';
const AUTOREBASE_FAILED_LABEL = 'autorebase:non-rebaseable';

const COMMENT_FIELDS = 'author { login } body createdAt url';

/** Everything the review panel shows for one PR, read fresh (no cache). */
async function getPullRequest(owner, repo, number) {
  const data = await graphql(`query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner squashMergeAllowed rebaseMergeAllowed mergeCommitAllowed defaultBranchRef { name }
      autorebase: label(name: "${AUTOREBASE_LABEL}") { id }
      pullRequest(number: $number) {
        id number title url state isDraft merged mergedAt body createdAt updatedAt
        author { login }
        headRefName baseRefName headRefOid
        mergeable mergeStateStatus reviewDecision
        additions deletions changedFiles
        labels(first: 30) { nodes { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } } }
        latestOpinionatedReviews(first: 20) { nodes { author { __typename login } state submittedAt url } }
        comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
        reviews(last: 30) { nodes { author { login } state body submittedAt url } }
        reviewThreads(last: 50) { nodes { isResolved isOutdated path line comments(first: 20) { nodes { ${COMMENT_FIELDS} } } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
        } } } } } }
      }
    }
  }`, { owner, repo, number });
  const r = data?.repository;
  const pr = r?.pullRequest;
  if (!pr) throw new Error(`${owner}/${repo}#${number} was not found, or your GitHub login cannot see it.`);
  const commit = pr.commits?.nodes?.[0]?.commit;
  const labels = (pr.labels?.nodes || []).map(l => l.name);
  return {
    kind: 'pr',
    id: pr.id, repo: r.nameWithOwner, number: pr.number, title: pr.title, url: pr.url,
    state: pr.state, isDraft: pr.isDraft, merged: pr.merged, mergedAt: pr.mergedAt,
    body: pr.body || '', author: pr.author?.login || 'ghost', createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    headRef: pr.headRefName, baseRef: pr.baseRefName, headOid: pr.headRefOid,
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
  const data = await graphql(`query {
    mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
    review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 50) {
      nodes { ... on PullRequest { ${PR_FIELDS} createdAt author { login } } }
    }
  }`);
  const toItem = (node) => {
    if (!node?.number) return null;
    const pr = shapePr(node, 'linked');
    const item = {
      repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, state: 'OPEN', stateReason: null,
      updatedAt: pr.updatedAt, author: node.author?.login || 'ghost', assignees: [],
      pullRequests: [pr], isPullRequest: true,
    };
    item.status = itemStatus(item);
    return item;
  };
  return {
    mine: (data?.mine?.nodes || []).map(toItem).filter(Boolean),
    review: (data?.review?.nodes || []).map(toItem).filter(Boolean),
    fetchedAt: new Date().toISOString(),
  };
}

/** Run a GitHub call for the renderer; errors become { error } like the rest of IPC. */
function asResult(promise) {
  return promise.then(v => (v && v.ok !== undefined ? v : { ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = {
  parseRef, formatRef, linkedIssueRefs, itemStatus, summarize, shapeIssue, getTracker, ITEM_STATUSES,
  humanReview, isIgnoredReviewer, getMyPullRequests, getPullRequest, getPullRequestFiles, getReviewComments, createReviewComment, replyToReviewComment, getIssue, setAutorebase, mergePullRequest, asResult, AUTOREBASE_LABEL,
  phasesFrom, shapeFieldValues, shapeProjectValues, phaseFieldsFor, issueFieldsOf, setIssueField, seedPhaseField, setIssueClosed, renameIssue, createTodo, updatePlan, setIssueMilestone,
  milestonePlanFromTable, seedMilestones, cloneRepo,
};
