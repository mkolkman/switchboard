const fs = require('fs');
const path = require('path');

// Which git repository a folder belongs to, read straight from .git/config so
// it costs no git process. A worktree's `.git` is a file pointing at its gitdir,
// whose `commondir` leads back to the main repository's config, so a worktree
// resolves to the same repo as its checkout.

/** "owner/name" parts of a remote URL (https, ssh or scp-style), or null. */
function parseRemoteUrl(url) {
  const match = String(url || '').trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

/** Remote URLs by remote name, from the text of a git config file. */
function parseRemotes(configText) {
  const remotes = {};
  let current = null;
  for (const raw of String(configText || '').split('\n')) {
    const line = raw.trim();
    const section = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/);
    if (section) { current = section[1]; continue; }
    if (line.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url && !remotes[current]) remotes[current] = url[1].trim();
  }
  return remotes;
}

// The repository's config file for `dir`, walking up to the first `.git`.
function findGitConfig(dir) {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch {}
    if (stat?.isDirectory()) return { root: current, config: path.join(dotGit, 'config') };
    if (stat?.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!pointer) return null;
      const gitDir = path.resolve(current, pointer[1].trim());
      let commonDir = gitDir;
      try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch {}
      return { root: current, config: path.join(commonDir, 'config') };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** { owner, name, root } for the repo `dir` sits in, or null when it has no remote. */
function repoInfoForPath(dir) {
  try {
    const found = findGitConfig(dir);
    if (!found) return null;
    const remotes = parseRemotes(fs.readFileSync(found.config, 'utf8'));
    const url = remotes.origin || Object.values(remotes)[0];
    const parsed = parseRemoteUrl(url);
    return parsed ? { ...parsed, root: found.root } : null;
  } catch {
    return null;
  }
}

/** repoInfoForPath for many folders at once: { [path]: info | null }. */
function repoInfoForPaths(paths) {
  const result = {};
  for (const p of paths || []) {
    if (typeof p === 'string' && p) result[p] = repoInfoForPath(p);
  }
  return result;
}

module.exports = { parseRemoteUrl, parseRemotes, repoInfoForPath, repoInfoForPaths };
