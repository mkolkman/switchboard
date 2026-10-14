/**
 * preview-mcp.js: an MCP server, over HTTP on 127.0.0.1, that gives each
 * Claude session one tool: open_preview, which shows a page in the browser
 * beside that session.
 *
 * Claude Code only shows the model two tools of an IDE server (see
 * mcp-bridge.js), so this one is a server of its own, handed to the session
 * with --mcp-config. One server serves every session; the path names the
 * session, behind a token made at start-up.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SERVER_NAME = 'switchboard';
const TOOL_NAME = 'open_preview';
// What --allowedTools needs, so opening a preview never asks for permission.
const TOOL_ID = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

const TOOLS = [{
  name: TOOL_NAME,
  description: 'Open a web page in the browser panel beside this session in Switchboard, for the user to look at. '
    + 'Use it when you have something to show: a dev server you started (http://localhost:5173), '
    + 'a static HTML file you wrote (its absolute path), or a published claude.ai artifact link. '
    + 'The panel reloads by itself when your turn ends, so open a page once.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'An http(s) URL, or the absolute path of a local HTML file' } },
    required: ['url'],
  },
}];

/** The URL to load for what the tool was given, or an error to send back. */
function previewTarget(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return { url: text };
  if (/^file:\/\//i.test(text)) return { url: text };
  if (path.isAbsolute(text)) {
    if (!fs.existsSync(text)) return { error: `No file at ${text}` };
    return { url: pathToFileURL(text).href };
  }
  return { error: 'Give an http(s) URL or an absolute file path.' };
}

/** One JSON-RPC request in, its response out (null for a notification). */
function handleRpc(msg, sessionId, onOpen) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'Switchboard preview', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (msg.params?.name !== TOOL_NAME) return fail(-32602, `Unknown tool ${msg.params?.name}`);
      const target = previewTarget(msg.params?.arguments?.url);
      if (target.error) return reply({ content: [{ type: 'text', text: target.error }], isError: true });
      const opened = onOpen(sessionId, target.url);
      return reply({ content: [{ type: 'text', text: opened ? `Opened ${target.url} beside the session.` : 'Switchboard has no window to show it in.' }] });
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function createPreviewMcpServer({ onOpen, log }) {
  const token = crypto.randomBytes(16).toString('hex');
  let server = null;
  let port = null;

  async function start() {
    if (server) return port;
    server = http.createServer((req, res) => {
      const match = req.url.match(/^\/mcp\/([0-9a-f]+)\/([A-Za-z0-9-]+)$/);
      if (!match || match[1] !== token) { res.writeHead(404).end(); return; }
      // Streamable HTTP: no server-sent stream, plain JSON answers.
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        const list = Array.isArray(msg) ? msg : [msg];
        const out = list.map(m => handleRpc(m, match[2], onOpen)).filter(Boolean);
        if (!out.length) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
    log?.info?.(`[preview-mcp] listening on 127.0.0.1:${port}`);
    return port;
  }

  /** Arguments for the claude command line that give a session the tool. */
  async function launchArgs(sessionId) {
    await start();
    const config = { mcpServers: { [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}/${sessionId}` } } };
    return ['--mcp-config', JSON.stringify(config), '--allowedTools', TOOL_ID];
  }

  function stop() {
    server?.close();
    server = null;
  }

  return { start, launchArgs, stop };
}

module.exports = { createPreviewMcpServer, handleRpc, previewTarget, TOOL_ID };
