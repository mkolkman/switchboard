const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { findPreviewUrls, createPreviewWatcher } = require('../preview-urls');
const { handleRpc, previewTarget, prFilesTarget, prFilesReply, createPreviewMcpServer, TOOL_ID, PR_FILES_TOOL_ID } = require('../preview-mcp');

test('findPreviewUrls finds dev servers and artifact links, not other sites', () => {
  const out = '  VITE ready\n  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'
    + 'Serving on http://0.0.0.0:8000. See https://github.com/x/y and https://claude.ai/code/artifact/abc-123.\n';
  assert.deepEqual(findPreviewUrls(out), ['http://localhost:5173/', 'http://localhost:8000', 'https://claude.ai/code/artifact/abc-123']);
});

test('findPreviewUrls reads the target of an OSC 8 hyperlink', () => {
  const out = '\x1b]8;;https://claude.ai/artifact/xyz\x07the page\x1b]8;;\x07\n';
  assert.deepEqual(findPreviewUrls(out), ['https://claude.ai/artifact/xyz']);
});

test('the watcher joins a URL split across chunks, opens it once, and stays quiet while a resume replays', () => {
  let t = 0;
  const w = createPreviewWatcher({ quietMs: 1000, now: () => t });
  assert.deepEqual(w.feed('old: http://localhost:3000/\n'), []);
  t = 5000;
  assert.deepEqual(w.feed('again http://localhost:3000/\n'), []);
  assert.deepEqual(w.feed('Local: http://localh'), []);
  assert.deepEqual(w.feed('ost:5173/\n'), ['http://localhost:5173/']);
  assert.deepEqual(w.feed('Local: http://localhost:5173/\n'), []);
});

test('previewTarget takes URLs and absolute paths of existing files', () => {
  assert.deepEqual(previewTarget('http://localhost:5173'), { url: 'http://localhost:5173' });
  assert.match(previewTarget(path.join(__dirname, 'preview.test.js')).url, /^file:\/\/.*preview\.test\.js$/);
  assert.ok(previewTarget('/no/such/file.html').error);
  assert.ok(previewTarget('index.html').error);
});

test('handleRpc lists the tool and opens a preview for the session', () => {
  const opened = [];
  const onOpen = (sid, url) => { opened.push([sid, url]); return true; };
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 's1', onOpen), null);
  assert.equal(handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 's1', onOpen).result.tools[0].name, 'open_preview');
  const res = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_preview', arguments: { url: 'http://localhost:5173' } } }, 's1', onOpen);
  assert.deepEqual(opened, [['s1', 'http://localhost:5173']]);
  assert.ok(!res.result.isError);
});

test('prFilesTarget takes a PR by key or URL and the files of a step with their lines', () => {
  assert.deepEqual(prFilesTarget({ pr: 'https://github.com/MoveLab-Studio/App/pull/12/files', step: ' Stap 3: Adapters ', files: [{ path: '/app/A.php', lines: '31-23' }, { path: 'b.js', lines: '7' }, 'c.js', { path: '' }] }), {
    pr: 'MoveLab-Studio/App#12', title: 'Stap 3: Adapters',
    files: [{ path: 'app/A.php', start: 23, end: 31 }, { path: 'b.js', start: 7, end: 7 }, { path: 'c.js', start: null, end: null }],
  });
  assert.equal(prFilesTarget({ pr: 'owner/repo#5', files: ['x.js'] }).pr, 'owner/repo#5');
  assert.ok(prFilesTarget({ pr: '#5', files: ['x.js'] }).error);
  assert.ok(prFilesTarget({ pr: 'owner/repo#5', files: [] }).error);
});

test('handleRpc offers show_pr_files only with a handler, and sends the step for the session', async () => {
  const onOpen = () => true;
  const steps = [];
  const onShow = (sid, step) => { steps.push([sid, step.pr, step.files.length]); return Promise.resolve({ shown: true, missing: [] }); };
  assert.deepEqual(handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 's1', onOpen).result.tools.map(t => t.name), ['open_preview']);
  assert.deepEqual(handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 's1', onOpen, onShow).result.tools.map(t => t.name), ['open_preview', 'show_pr_files']);
  const res = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show_pr_files', arguments: { pr: 'o/r#1', files: [{ path: 'a.js' }] } } }, 's1', onOpen, onShow);
  assert.ok(!res.result.isError);
  assert.match(res.result.content[0].text, /^Showing 1 file of o\/r#1/);
  assert.deepEqual(steps, [['s1', 'o/r#1', 1]]);
  assert.ok((await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'show_pr_files', arguments: { pr: 'nope', files: ['a.js'] } } }, 's1', onOpen, onShow)).result.isError);
  assert.ok(handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'show_pr_files', arguments: {} } }, 's1', onOpen).error);
});

// The bug behind this: a step for a session that was not on screen was queued,
// but the tool still said "Showing ... beside the session".
test('show_pr_files answers with what the window did, never success it did not have', async () => {
  const step = prFilesTarget({ pr: 'o/r#1', files: ['a.js', 'b.js'] });
  const queued = prFilesReply(step, { queued: true });
  assert.ok(!/^Showing/.test(queued.content[0].text));
  assert.match(queued.content[0].text, /not on screen/);
  assert.ok(prFilesReply(step, { error: 'None of these files are in o/r#1' }).isError);
  assert.ok(prFilesReply(step, null).isError);
  assert.match(prFilesReply(step, { shown: true, missing: ['b.js'] }).content[0].text, /^Showing 1 file of o\/r#1.*Not in the PR, so not shown: b\.js/);
  const failing = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'show_pr_files', arguments: { pr: 'o/r#1', files: ['a.js'] } } }, 's1', () => true, () => Promise.reject(new Error('window gone')));
  assert.ok(failing.result.isError);
  assert.match(failing.result.content[0].text, /window gone/);
});

test('a server with a step handler allows both tools', async () => {
  const server = createPreviewMcpServer({ onOpen: () => true, onShowPrFiles: () => true });
  try {
    const args = await server.launchArgs('abc-123');
    assert.deepEqual(args.slice(2), ['--allowedTools', `${TOOL_ID} ${PR_FILES_TOOL_ID}`]);
  } finally { server.stop(); }
});

test('the server answers MCP over HTTP behind its token', async () => {
  const opened = [];
  const server = createPreviewMcpServer({ onOpen: (sid, url) => { opened.push([sid, url]); return true; } });
  const args = await server.launchArgs('abc-123');
  assert.equal(args[0], '--mcp-config');
  assert.deepEqual(args.slice(2), ['--allowedTools', TOOL_ID]);
  const url = JSON.parse(args[1]).mcpServers.switchboard.url;
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  try {
    const init = await (await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_preview', arguments: { url: 'http://localhost:1234' } } });
    assert.deepEqual(opened, [['abc-123', 'http://localhost:1234']]);
    assert.equal((await post(url.replace(/\/mcp\/[0-9a-f]+\//, '/mcp/00/'), { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 404);
  } finally {
    server.stop();
  }
});

test('the BROWSER script sends prototype pages to Switchboard and the rest to the system browser', async () => {
  const os = require('os');
  const fs = require('fs');
  const { execFile } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-browser-'));
  const opened = [];
  const server = createPreviewMcpServer({ onOpen: (sid, url) => { opened.push([sid, url]); return true; }, scriptDir: dir });
  try {
    const env = await server.launchEnv('abc-123');
    assert.equal(fs.statSync(env.BROWSER).mode & 0o111, 0o111);
    // A fake `open` on PATH records what would have gone to the system browser.
    fs.writeFileSync(path.join(dir, 'open'), `#!/bin/sh\necho "$1" >> "${dir}/system.txt"\n`, { mode: 0o755 });
    // Async: the server answering the script runs in this same process.
    const run = (url) => new Promise((resolve, reject) => execFile(env.BROWSER, [url], { env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } }, err => err ? reject(err) : resolve()));
    await run('https://claude.ai/code/artifact/abc');
    await run('http://localhost:5173/');
    await run('https://github.com/x/y');
    assert.deepEqual(opened, [['abc-123', 'https://claude.ai/code/artifact/abc'], ['abc-123', 'http://localhost:5173/']]);
    assert.equal(fs.readFileSync(path.join(dir, 'system.txt'), 'utf8'), 'https://github.com/x/y\n');
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
