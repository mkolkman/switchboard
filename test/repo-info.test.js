const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRemoteUrl, parseRemotes, repoInfoForPath } = require('../repo-info');

test('parseRemoteUrl handles ssh, scp-style and https remotes', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:MoveLab-Studio/CityRow-App.git'), { owner: 'MoveLab-Studio', name: 'CityRow-App' });
  assert.deepEqual(parseRemoteUrl('https://github.com/doctly/switchboard.git'), { owner: 'doctly', name: 'switchboard' });
  assert.deepEqual(parseRemoteUrl('https://github.com/doctly/switchboard/'), { owner: 'doctly', name: 'switchboard' });
  assert.deepEqual(parseRemoteUrl('ssh://git@bitbucket.org/cityrow/crgo-web.git'), { owner: 'cityrow', name: 'crgo-web' });
  assert.equal(parseRemoteUrl(''), null);
  assert.equal(parseRemoteUrl(undefined), null);
});

test('parseRemotes reads every remote section and nothing else', () => {
  const remotes = parseRemotes(`
[core]
\turl = not-a-remote
[remote "origin"]
\turl = git@github.com:a/b.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "upstream"]
\turl = https://github.com/c/d.git
[branch "main"]
\tremote = origin
`);
  assert.deepEqual(remotes, { origin: 'git@github.com:a/b.git', upstream: 'https://github.com/c/d.git' });
});

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-info-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'CityRow-App');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:MoveLab-Studio/CityRow-App.git\n');
  return { dir, main };
}

test('repoInfoForPath resolves a subfolder to its repository', (t) => {
  const { main } = makeRepo(t);
  fs.mkdirSync(path.join(main, 'app', 'src'), { recursive: true });
  assert.deepEqual(repoInfoForPath(path.join(main, 'app', 'src')), { owner: 'MoveLab-Studio', name: 'CityRow-App', root: main });
});

test('repoInfoForPath follows a worktree back to the main repository config', (t) => {
  const { main } = makeRepo(t);
  const gitDir = path.join(main, '.git', 'worktrees', 'feature');
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  const worktree = path.join(main, '.worktrees', 'feature');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  assert.deepEqual(repoInfoForPath(worktree), { owner: 'MoveLab-Studio', name: 'CityRow-App', root: worktree });
});

test('repoInfoForPath is null outside a repository or without a remote', (t) => {
  const { dir } = makeRepo(t);
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  const local = path.join(dir, 'local');
  fs.mkdirSync(path.join(local, '.git'), { recursive: true });
  fs.writeFileSync(path.join(local, '.git', 'config'), '[core]\n\tbare = false\n');
  assert.equal(repoInfoForPath(local), null);
  // A tmp dir may itself sit inside a repo on some machines; only assert when it does not.
  if (repoInfoForPath(dir) === null) assert.equal(repoInfoForPath(plain), null);
  assert.equal(repoInfoForPath(path.join(dir, 'missing')), null);
});

test('findLocalClones finds main checkouts one level inside a root', (t) => {
  const { findLocalClones } = require('../repo-info');
  const { dir, main } = makeRepo(t);
  const worktree = path.join(dir, 'CityRow-App-wt', '.worktrees', 'x');
  fs.mkdirSync(worktree, { recursive: true });
  const found = findLocalClones(['MoveLab-Studio/CityRow-App', 'MoveLab-Studio/Missing'], { roots: [dir] });
  assert.deepEqual(found, { 'movelab-studio/cityrow-app': main, 'movelab-studio/missing': null });
});
