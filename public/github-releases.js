// github-releases.js: how a merged PR's release status reads in the list.
//
// The status itself is worked out in github-tracker.js (getReleaseStatus):
// { state: 'unreleased' | 'released', model, stage, tag, targets }. Loaded
// by the renderer as a classic script and required by the tests, like
// github-phases.js.

(function (root) {
  // Furthest from production first; a tag without a stage table sits below internal.
  const RELEASE_ORDER = ['unreleased', 'tagged', 'internal', 'beta', 'production'];

  /** The rung of RELEASE_ORDER a status is on. */
  function releaseKind(status) {
    if (status.state !== 'released') return 'unreleased';
    return status.stage || 'tagged';
  }

  /** An issue is out once all its merged PRs are: the one furthest behind. */
  function leastReleased(statuses) {
    let least = null;
    for (const s of statuses) {
      if (s && (!least || RELEASE_ORDER.indexOf(releaseKind(s)) < RELEASE_ORDER.indexOf(releaseKind(least)))) least = s;
    }
    return least;
  }

  /** "staging", "not released", "production 1.41.20", "internal 3.42.0", "tagged 2.41.3". */
  function releaseText(status) {
    if (status.state !== 'released') return status.model === 'tagged' ? 'staging' : 'not released';
    return `${status.stage || 'tagged'} ${status.tag}`;
  }

  /** The longer story for a tooltip: what the state means, and the targets per stage. */
  function releaseDetail(status) {
    if (status.state !== 'released') {
      return status.model === 'tagged'
        ? 'Merged; main deploys to staging. Not in a production tag yet.'
        : 'Merged, not in a release tag yet.';
    }
    if (!status.targets) {
      return status.model === 'staged'
        ? `In tag ${status.tag}; its GitHub Release has no stage table.`
        : `In production since tag ${status.tag}.`;
    }
    return RELEASE_ORDER.slice(2).reverse()
      .filter(stage => status.targets[stage]?.length)
      .map(stage => `${stage}: ${status.targets[stage].map(t => `${t.target} ${t.tag}${t.rollout < 100 ? ` (${t.rollout}%)` : ''}`).join(', ')}`)
      .join('\n');
  }

  const api = { RELEASE_ORDER, releaseKind, leastReleased, releaseText, releaseDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
