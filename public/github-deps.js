// github-deps.js: which issues of a plan wait on which, from GitHub's
// "blocked by" relations.
//
// github-tracker.js gives every issue blockedBy and blocking lists of
// { repo, number, title, url, state }. This file turns them into the row's
// "waits on" pill and the plan's graph: edges from a blocker to what it
// blocks, and cards laid out in columns (the plan's phases, or the depth of
// the chain when there are none). Loaded by the renderer as a classic script
// and required by the tests, like github-phases.js.

(function (root) {
  const depKey = (d) => `${d.repo}#${d.number}`;

  /** The blockers of an issue that are not closed yet. */
  function openBlockers(item) {
    return (item.blockedBy || []).filter(d => d.state !== 'CLOSED');
  }

  /**
   * Every blocker → blocked edge between the plan's items, from both sides of
   * the relation. A blocker outside the plan comes along in `outside`, so the
   * graph can show what an issue waits on even when it is not in the plan.
   */
  function depEdges(items) {
    const inPlan = new Set(items.map(depKey));
    const edges = [];
    const seen = new Set();
    const outside = new Map();
    const add = (from, to) => {
      const id = `${depKey(from)}>${depKey(to)}`;
      if (seen.has(id)) return;
      seen.add(id);
      edges.push({ from: depKey(from), to: depKey(to) });
      for (const end of [from, to]) if (!inPlan.has(depKey(end))) outside.set(depKey(end), end);
    };
    for (const item of items) {
      for (const d of item.blockedBy || []) add(d, item);
      // What it blocks only counts inside the plan: the rest is someone else's work.
      for (const d of item.blocking || []) if (inPlan.has(depKey(d))) add(item, d);
    }
    return { edges, outside };
  }

  /**
   * Columns by the length of the chain in front of a card: the first column
   * waits on nothing, the next only on the first, and so on. A cycle stops
   * where it closes.
   */
  function depthColumns(keys, edges) {
    const blockers = new Map(keys.map(k => [k, []]));
    for (const e of edges) if (blockers.has(e.to) && blockers.has(e.from)) blockers.get(e.to).push(e.from);
    const depth = new Map();
    const visit = (k, path) => {
      if (depth.has(k)) return depth.get(k);
      if (path.has(k)) return 0;
      path.add(k);
      const d = Math.max(-1, ...blockers.get(k).map(b => visit(b, path))) + 1;
      path.delete(k);
      depth.set(k, d);
      return d;
    };
    keys.forEach(k => visit(k, new Set()));
    const n = Math.max(0, ...depth.values()) + 1;
    return Array.from({ length: keys.length ? n : 0 }, (_, i) => ({
      id: `depth:${i}`,
      label: i === 0 ? 'Waits on nothing' : `Step ${i + 1}`,
      keys: keys.filter(k => depth.get(k) === i),
    }));
  }

  /**
   * Order each column's cards under the cards they wait on (the mean row of
   * their blockers in earlier columns), and mark the edges that point back
   * to an earlier column: a blocker planned after what it blocks.
   */
  function layoutGraph(columns, edges) {
    const col = new Map();
    columns.forEach((c, i) => c.keys.forEach(k => col.set(k, i)));
    const row = new Map();
    const laid = columns.map((c, i) => {
      const pull = (k) => {
        const rows = edges.filter(e => e.to === k && col.get(e.from) < i && row.has(e.from)).map(e => row.get(e.from));
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
      };
      const keys = c.keys.map((k, n) => ({ k, n, at: pull(k) }))
        .sort((a, b) => (a.at ?? a.n) - (b.at ?? b.n) || a.n - b.n)
        .map(x => x.k);
      keys.forEach((k, r) => row.set(k, r));
      return { ...c, keys };
    });
    const marked = edges
      .filter(e => col.has(e.from) && col.has(e.to))
      .map(e => ({ ...e, back: col.get(e.from) > col.get(e.to), same: col.get(e.from) === col.get(e.to) }));
    return { columns: laid, edges: marked };
  }

  const api = { depKey, openBlockers, depEdges, depthColumns, layoutGraph };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
