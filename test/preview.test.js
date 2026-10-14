const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { findPreviewUrls, createPreviewWatcher } = require('../preview-urls');
const { handleRpc, previewTarget, createPreviewMcpServer, TOOL_ID } = require('../preview-mcp');

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
