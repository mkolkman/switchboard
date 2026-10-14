const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The renderer's scripts are classic <script>s sharing one global scope. Two
// top-level `const`/`let` with the same name is a SyntaxError that stops the
// whole later script from loading (the app comes up empty), and two
// `function`s silently replace each other. Neither shows up in unit tests.
test('renderer scripts declare each top-level name once', () => {
  const dir = path.join(__dirname, '../public');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([a-z0-9-]+\.js)"><\/script>/g)]
    .map(m => m[1])
    .filter(name => !name.endsWith('-bundle.js'));
  assert.ok(scripts.length > 10, 'found the renderer scripts');
  const seen = new Map();
  const clashes = [];
  for (const name of scripts) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of text.matchAll(/^(?:const|let|var|function|async function|class) ([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== name) clashes.push(`${m[1]}: ${seen.get(m[1])} and ${name}`);
      else seen.set(m[1], name);
    }
  }
  assert.deepEqual(clashes, []);
});

// Valid syntax can still throw while a script loads (a stray identifier, a
// name used before its `let`), and then everything below it never runs while
// its hoisted functions half-work. Run the top level of the scripts that do
// not touch the DOM at load time, with just enough of a browser stubbed.
test('renderer scripts without load-time DOM work run their top level cleanly', () => {
  const vm = require('node:vm');
  const dir = path.join(__dirname, '../public');
  const ctx = vm.createContext({
    window: {}, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} }, document: {},
  });
  for (const name of ['session-groups.js', 'github-phases.js', 'github-releases.js', 'github-my-review.js', 'github-deps.js', 'project-github-view.js', 'project-github-source.js', 'github-wayfinder.js']) {
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), ctx, { filename: name }), name);
  }
  // The last top-level bindings of each file were reached.
  assert.doesNotThrow(() => vm.runInContext('githubMarkedRenderer; MERGE_STATE_TEXT; CLONE_PICKS_KEY; githubPlanUi; githubClones;', ctx));
});

test('githubPatchRows numbers old and new lines across hunks', () => {
  const vm = require('node:vm');
  const ctx = vm.createContext({ document: { addEventListener() {} }, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/project-github-review.js'), 'utf8'), ctx);
  const rows = vm.runInContext(`githubPatchRows(${JSON.stringify('@@ -10,3 +10,4 @@ class A\n keep\n-old\n+new\n+added\n keep2\n\\ No newline at end of file\n@@ -40 +41 @@\n-x\n+y')})`, ctx);
  const simple = rows.map(r => [r.kind, r.oldNo ?? null, r.newNo ?? null]);
  assert.deepEqual(JSON.parse(JSON.stringify(simple)), [
    ['hunk', null, null], ['context', 10, 10], ['remove', 11, null], ['add', null, 11], ['add', null, 12],
    ['context', 12, 13], ['meta', null, null], ['hunk', null, null], ['remove', 40, null], ['add', null, 41],
  ]);
});
