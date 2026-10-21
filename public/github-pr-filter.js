// github-pr-filter.js: what the GitHub tab's search and filters know about a
// PR: its type (security, bugfix, feature, upkeep), its products, the plan
// (parent issue) it falls under, and whether it matches a filter. Loaded by
// the renderer as a classic script and required by the tests, like
// github-releases.js. An item is a list item of github-tracker.js
// getMyPullRequests: { repo, number, title, author, branch, labels, issues }.

(function (root) {
  const PR_TYPES = ['security', 'bugfix', 'feature', 'upkeep'];
  const PR_TYPE_LABELS = { security: 'Security', bugfix: 'Bugfix', feature: 'Feature', upkeep: 'Upkeep' };
  // An icon per type (24-unit paths, stroked in the type's colour): shield, bug, sparkles, wrench.
  const PR_TYPE_PATHS = {
    security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    bugfix: '<path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6.5 13H3M21 13h-3.5M6 9 3.5 7M18 9l2.5-2M6 17l-2.5 2M18 17l2.5 2"/>',
    feature: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    upkeep: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  };

  /** A type's icon as inline SVG. */
  function prTypeIcon(type, size = 12) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PR_TYPE_PATHS[type] || ''}</svg>`;
  }

  const SECURITY_LABEL = /^(security-scan|severity:.+|security)$/i;
  const BUG_LABEL = /^(type:broken|type:correctness|crash|bug)$/i;
  const SECURITY_TITLE = /\bsecurity\b|vulnerab|\bcve-\d|\bxss\b|\bcsrf\b|\bsecrets?\b|\bexpos(e|es|ed|ure)\b|\bleak|\bsigned links?\b|\bprivately\b/i;
  const BUG_TITLE = /^(\s*\[[^\]]*\])*\s*fix\s|\bcrash(es|ing)?\b/i;
  const UPKEEP_TITLE = /^(\s*\[[^\]]*\])*\s*(\[infra\]|bump\b|update dependenc|upgrade\b.*\bto v?\d)|\[infra\]/i;
  const BOTS = /^(dependabot|renovate|github-actions)(\[bot\])?$/i;

  /**
   * A PR's type and why: its linked issues first (labels, then GitHub's issue
   * type), then the PR itself (title, branch, author); a feature when nothing
   * says otherwise. { type, reason }.
   */
  function prType(item) {
    const issues = item.issues || [];
    const labels = [...(item.labels || []), ...issues.flatMap(i => i.labels || [])];
    if (labels.some(l => SECURITY_LABEL.test(l))) return { type: 'security', reason: 'security label on the PR or its issue' };
    if (labels.some(l => BUG_LABEL.test(l))) return { type: 'bugfix', reason: 'bug label on its issue' };
    const issueType = issues.map(i => String(i.type || '').toLowerCase()).find(Boolean);
    if (issueType === 'bug') return { type: 'bugfix', reason: 'its issue is a Bug' };
    if (issueType === 'feature') return { type: 'feature', reason: 'its issue is a Feature' };
    const title = String(item.title || '');
    if (SECURITY_TITLE.test(title)) return { type: 'security', reason: 'guessed from the title' };
    if (SECURITY_TITLE.test(String(item.branch || '').replace(/[-_/]/g, ' '))) return { type: 'security', reason: 'guessed from the branch' };
    if (BOTS.test(item.author || '') || UPKEEP_TITLE.test(title)) return { type: 'upkeep', reason: BOTS.test(item.author || '') ? 'opened by a bot' : 'guessed from the title' };
    if (/^(fix|bugfix|hotfix)[/-]/i.test(item.branch || '') || BUG_TITLE.test(title)) return { type: 'bugfix', reason: /^(fix|bugfix|hotfix)[/-]/i.test(item.branch || '') ? 'guessed from the branch' : 'guessed from the title' };
    return { type: 'feature', reason: issueType ? `its issue is a ${issueType}` : 'nothing says it is a fix or upkeep' };
  }

  // The products a repo serves (the Production tab's ids), and for the repos
  // serving several, the title prefixes that name one.
  const REPO_PRODUCTS = {
    'MoveLab-Connect-Web': ['mlc', 'cityrow'],
    'MoveLab-Connect-Android': ['mlc', 'nohrd', 'waterrower', 'drwolff', 'rp3'],
    'NOHRD-Account': ['nohrd', 'waterrower'],
    'NOHRD-Data': ['nohrd', 'waterrower'],
    'NOHRD-Fixed': ['nohrd'],
    'WATERROWER-NOHRD-Connect': ['nohrd', 'waterrower'],
    'CityRow-App': ['cityrow'],
    'RP3-App': ['rp3'],
    'RP3-Rowing-Web': ['rp3'],
  };
  const PREFIX_PRODUCTS = [
    [/^(WR[ACI]?|WRC|WaterRower)$/i, 'waterrower'],
    [/^(NC[AI]?|NOHRD|NOHrD|Slimbeam)$/i, 'nohrd'],
    [/^CityRow/i, 'cityrow'],
    [/^(RP3|Run-Row-Run)$/i, 'rp3'],
    [/^(Dr\.? ?Wolff)$/i, 'drwolff'],
  ];
  const PRODUCT_LABELS = { mlc: 'MLC', nohrd: 'NOHRD', waterrower: 'WaterRower', cityrow: 'CITYROW', drwolff: 'Dr. Wolff', rp3: 'RP3' };

  /** The products a PR is about: named by its title's prefixes, else all its repo serves; [] for other repos. */
  function prProducts(item) {
    const repo = String(item.repo || '').split('/').pop();
    const served = REPO_PRODUCTS[repo] || [];
    if (served.length <= 1) return served;
    const prefixes = [...String(item.title || '').matchAll(/\[([^\]]+)\]/g)].map(m => m[1].split(/[→\s]/)[0]);
    const named = [...new Set(prefixes.flatMap(p => PREFIX_PRODUCTS.filter(([re]) => re.test(p)).map(([, id]) => id)))].filter(id => served.includes(id));
    return named.length ? named : served;
  }

  /** The plans (parent issues: a pitch or wayfinder map) a PR falls under: [{ key, number, title, url }]. */
  function prPlans(item) {
    const seen = new Map();
    for (const issue of item.issues || []) {
      const p = issue.parent;
      if (!p?.number) continue;
      const key = `${p.repo || item.repo}#${p.number}`;
      if (!seen.has(key)) seen.set(key, { key, number: p.number, title: p.title || `#${p.number}`, url: p.url || '' });
    }
    return [...seen.values()];
  }

  /**
   * Whether an item passes the filter: { q, product, repo, plan, types }. The
   * text matches title, #number, repo, author, branch, and the titles of its
   * issues and plans; the others must equal one of the item's (types: any of).
   */
  function prMatches(item, filter = {}) {
    if (filter.product && !prProducts(item).includes(filter.product)) return false;
    if (filter.repo && item.repo !== filter.repo) return false;
    if (filter.plan && !prPlans(item).some(p => p.key === filter.plan)) return false;
    if (filter.types?.length && !filter.types.includes(prType(item).type)) return false;
    const words = String(filter.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [
      item.title, `#${item.number}`, item.repo, item.author, item.branch,
      ...(item.issues || []).flatMap(i => [i.title, `#${i.number}`]),
      ...prPlans(item).map(p => p.title),
    ].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  }

  /** Whether a filter filters anything. */
  function filterActive(filter = {}) {
    return !!(String(filter.q || '').trim() || filter.product || filter.repo || filter.plan || filter.types?.length);
  }

  const api = { PR_TYPES, PR_TYPE_LABELS, prTypeIcon, PRODUCT_LABELS, REPO_PRODUCTS, prType, prProducts, prPlans, prMatches, filterActive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
