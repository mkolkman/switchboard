/**
 * access-watch.js: which session is asking for access. macOS shows every
 * privacy dialog (TCC) and 1Password every approval as coming from
 * Switchboard, because the sessions run under it; with several sessions at
 * once nobody can tell which one asks, or why.
 *
 * - macOS dialogs: tccd logs AUTHREQ_PROMPTING the moment it shows one, with
 *   the pid of the process that asked, and AUTHREQ_RESULT once answered.
 *   `log stream` hands both over within milliseconds.
 * - 1Password: its approval is no TCC dialog and logs nothing we can read.
 *   An `op` that is still running after a poll or two waits for it, so `op`
 *   processes are polled; one is done when it exits.
 *
 * Either way the process is traced up the process tree to the `claude` of a
 * session. Its command line is shown, `op`'s without arguments that hold a
 * value (`password=…`), with why: the session's transcript already holds the
 * tool call that is still running (runningToolReason).
 */

const { spawn, execFile } = require('child_process');

// The services a dialog asks for, in the words the banner uses.
const SERVICE_LABELS = {
  SystemPolicyAppData: 'data of another app',
  SystemPolicyDocumentsFolder: 'your Documents folder',
  SystemPolicyDownloadsFolder: 'your Downloads folder',
  SystemPolicyDesktopFolder: 'your Desktop folder',
  SystemPolicyAllFiles: 'all your files',
  SystemPolicyNetworkVolumes: 'network volumes',
  SystemPolicyRemovableVolumes: 'removable volumes',
  SystemPolicyAppBundles: 'other apps',
  Photos: 'your photos',
  MediaLibrary: 'your media library',
  AddressBook: 'your contacts',
  Calendar: 'your calendars',
  Reminders: 'your reminders',
  AppleEvents: 'control of another app',
  Accessibility: 'accessibility',
  ListenEvent: 'input monitoring',
  ScreenCapture: 'screen recording',
  Camera: 'the camera',
  Microphone: 'the microphone',
};

const OP_POLL_MS = 700;
// Claude Code writes a tool call to the transcript a moment after it starts: look again.
const REASON_RETRIES_MS = [0, 400, 1000, 2000];
// A ! command reaches the transcript only once it has finished, so while its
// dialog waits there is nothing to find: no running tool call means that.
const NO_TOOL_REASON = { tool: 'bash', why: "No tool call of Claude's is running: probably a ! command typed in the session.", detail: '' };
const HISTORY_LIMIT = 20;

/** A tccd line saying it shows a dialog: { msgId, subject, service, pid }, or null. */
function parsePrompting(message) {
  const text = String(message || '');
  if (!text.includes('AUTHREQ_PROMPTING')) return null;
  const msgId = (text.match(/msgID=([\d.]+)/) || [])[1];
  const subject = (text.match(/subject=Sub:\{([^}]+)\}/) || [])[1];
  const service = (text.match(/service=kTCCService(\w+)/) || [])[1];
  const pid = Number((text.match(/Resp:\{TCCDProcess: identifier=[^,]*, pid=(\d+)/) || [])[1]);
  if (!msgId || !service || !pid) return null;
  return { msgId, subject: subject || null, service, pid };
}

/** A tccd line with a dialog's answer: { msgId, allowed }, or null. */
function parseResult(message) {
  const text = String(message || '');
  if (!text.includes('AUTHREQ_RESULT')) return null;
  const msgId = (text.match(/msgID=([\d.]+)/) || [])[1];
  const value = Number((text.match(/authValue=(\d+)/) || [])[1]);
  return msgId ? { msgId, allowed: value === 2 } : null;
}

/** `ps -axo pid=,ppid=,command=` as a Map pid → { ppid, command }. */
function parsePs(text) {
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return table;
}

/**
 * Who a process belongs to, up its process tree: the session whose `claude`
 * it runs under (sessionId), whether it runs under Switchboard at all, and
 * its own command line.
 */
function traceProcess(table, pid, { appPids = [] } = {}) {
  const command = table.get(pid)?.command || '';
  const app = new Set(appPids.map(Number));
  let sessionId = null;
  let underApp = false;
  for (let p = pid, hops = 0; p > 1 && hops < 40; hops++) {
    if (app.has(p)) underApp = true;
    const row = table.get(p);
    if (!row) break;
    const m = !sessionId && row.command.match(/(?:^|\/)claude\b.*?--(?:session-id|resume)[ =]([0-9a-f-]{36})/);
    if (m) sessionId = m[1];
    if (/\/Switchboard\.app\/Contents\/MacOS\/|pty-daemon\.js/.test(row.command)) underApp = true;
    p = row.ppid;
  }
  return { sessionId, underApp, command };
}

const COMMAND_MAX = 300;

/**
 * A command line as it may be shown. `ps` can run on into a process's
 * environment (a program that reuses its argument memory), so it stops at the
 * first NAME=value word; escapes like \012 become spaces.
 */
function safeCommand(command) {
  const words = String(command || '').replace(/\\0\d\d/g, ' ').trim().split(/\s+/).filter(Boolean);
  const env = words.findIndex(w => /^[A-Z_][A-Z0-9_]*=/.test(w));
  const text = (env >= 0 ? words.slice(0, env) : words).join(' ');
  return text.length > COMMAND_MAX ? `${text.slice(0, COMMAND_MAX - 1)}\u2026` : text;
}

/** An `op` command line to show: arguments that carry a value (`x=y`) are left out. */
function safeOpCommand(command) {
  const words = safeCommand(command).split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const name = words[0].split('/').pop();
  return [name, ...words.slice(1).filter(w => !w.includes('='))].join(' ');
}

/** The other app a path in the command reaches into, by its container id, or null. */
function containerOf(command) {
  return (String(command || '').match(/Library\/(?:Group )?Containers\/([^/\s]+)/) || [])[1] || null;
}

const WHY_MAX = 220;
// A call without a result that is older than this was cut off, not running.
const RUNNING_MAX_AGE_MS = 30 * 60 * 1000;

function blocksOf(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content)) return content;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [];
}

/** A tool call as a few words, for tools without a description of their own. */
function toolSummary(use) {
  const input = use.input || {};
  const target = input.file_path || input.path || input.pattern || input.url || input.command || '';
  return `${use.name}${target ? ` ${String(target).slice(0, 120)}` : ''}`;
}

/** The first sentence or two of what Claude wrote, short enough for a panel line. */
function shortText(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [flat];
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > WHY_MAX) break;
    out += s;
  }
  out = out.trim();
  return out.length > WHY_MAX ? `${out.slice(0, WHY_MAX - 1)}\u2026` : out;
}

/**
 * Why a session is running what asks for access, from its transcript
 * entries (oldest first): the tool call without a result yet, with what
 * Claude wrote just before it, else its own description of the command.
 * A `!` command typed in the session is the user's own. Null when neither.
 */
function runningToolReason(entries, now = Date.now()) {
  const recent = (e) => !e.timestamp || now - new Date(e.timestamp).getTime() < RUNNING_MAX_AGE_MS;
  const done = new Set();
  for (const e of entries) for (const b of blocksOf(e)) if (b.type === 'tool_result') done.add(b.tool_use_id);
  let running = null;
  let text = '';
  let userBash = false;
  for (const e of entries) {
    if (e.type === 'user') {
      const blocks = blocksOf(e);
      const plain = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (/<bash-input>/.test(plain)) userBash = recent(e);
      if (/<bash-stdout>|<bash-stderr>/.test(plain)) userBash = false;
      // A new prompt starts a new turn: what Claude wrote before it no longer explains anything.
      if (!blocks.some(b => b.type === 'tool_result') && !/<bash-/.test(plain)) text = '';
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const b of blocksOf(e)) {
      if (b.type === 'text' && b.text.trim()) text = b.text;
      if (b.type === 'tool_use' && !done.has(b.id)) running = recent(e) ? { use: b, text } : null;
    }
  }
  if (running) {
    const description = String(running.use.input?.description || '').trim();
    return {
      tool: running.use.name,
      why: shortText(running.text) || description || toolSummary(running.use),
      detail: running.text && description ? description : '',
    };
  }
  return userBash ? { tool: 'bash', why: 'You ran this command yourself.', detail: '' } : null;
}

function describeService(service, command) {
  const label = SERVICE_LABELS[service] || service.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const container = service === 'SystemPolicyAppData' ? containerOf(command) : null;
  return container ? `${label} (${container})` : label;
}

class AccessWatch {
  /**
   * bundleId: the app the dialogs name (ai.doctly.switchboard, or Electron
   * in development); send(channel, payload) reaches the window.
   */
  constructor({ bundleId, send, explain = null, log = console }) {
    this.bundleId = bundleId;
    this.explain = explain; // async sessionId → runningToolReason of its transcript
    this.send = send;
    this.log = log;
    this.pending = new Map(); // id → request still waiting
    this.history = []; // newest last, every request with its answer
    this.ops = new Map(); // op pid → { firstSeen, reported }
    this.stream = null;
    this.timer = null;
  }

  start() {
    if (process.platform !== 'darwin') return;
    this.startStream();
    this.timer = setInterval(() => this.pollOps().catch(err => this.log.warn?.(`[access] op poll: ${err.message}`)), OP_POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const stream = this.stream;
    this.stream = null;
    stream?.kill();
  }

  startStream() {
    const stream = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate',
      'process == "tccd" AND (eventMessage CONTAINS "AUTHREQ_PROMPTING" OR eventMessage CONTAINS "AUTHREQ_RESULT")']);
    this.stream = stream;
    let buf = '';
    stream.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        this.onLogMessage(event.eventMessage).catch(err => this.log.warn?.(`[access] ${err.message}`));
      }
    });
    stream.on('error', (err) => this.log.warn?.(`[access] log stream: ${err.message}`));
    // Restarted when it ends by itself, never after stop().
    stream.on('exit', () => {
      if (this.stream !== stream) return;
      this.stream = null;
      setTimeout(() => { if (this.timer) this.startStream(); }, 5000);
    });
  }

  async onLogMessage(message) {
    const prompt = parsePrompting(message);
    if (prompt) {
      if (prompt.subject !== this.bundleId) return;
      const { sessionId, command } = traceProcess(await psTable(), prompt.pid, { appPids: [process.pid] });
      this.add({
        id: `tcc:${prompt.msgId}`, kind: 'tcc', service: prompt.service, what: describeService(prompt.service, command),
        sessionId, command: safeCommand(command), pid: prompt.pid,
      });
      return;
    }
    const result = parseResult(message);
    if (result && this.pending.has(`tcc:${result.msgId}`)) this.answer(`tcc:${result.msgId}`, result.allowed ? 'allowed' : 'denied');
  }

  async pollOps() {
    const pids = await pgrep('op');
    const now = Date.now();
    for (const [pid, seen] of this.ops) {
      if (pids.includes(pid)) continue;
      this.ops.delete(pid);
      if (seen.reported) this.answer(`op:${pid}`, 'done');
    }
    let table = null;
    for (const pid of pids) {
      const seen = this.ops.get(pid);
      if (!seen) { this.ops.set(pid, { firstSeen: now, reported: false }); continue; }
      // Still running a poll later: it waits for 1Password's approval.
      if (seen.reported) continue;
      seen.reported = true;
      table = table || await psTable();
      const { sessionId, underApp, command } = traceProcess(table, pid, { appPids: [process.pid] });
      if (!underApp) continue; // an `op` in a terminal of its own
      if (/(?:^|\/)op daemon\b/.test(command)) continue; // 1Password CLI's own background process, never waiting
      this.add({ id: `op:${pid}`, kind: 'op', what: '1Password', sessionId, command: safeOpCommand(command), pid });
    }
  }

  /** A request shows at once; why it is asked follows when the transcript has it. */
  async add(request) {
    const entry = { ...request, reason: null, at: new Date().toISOString(), answer: null };
    this.pending.set(entry.id, entry);
    this.history.push(entry);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    this.send('access-request', entry);
    if (!request.sessionId || !this.explain) return;
    for (const wait of REASON_RETRIES_MS) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      try { entry.reason = await this.explain(request.sessionId); } catch (err) { this.log.warn?.(`[access] why: ${err.message}`); return; }
      if (entry.reason) {
        this.send('access-reason', { id: entry.id, reason: entry.reason });
        return;
      }
    }
    entry.reason = NO_TOOL_REASON;
    this.send('access-reason', { id: entry.id, reason: entry.reason });
  }

  answer(id, answer) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.answer = answer;
    entry.answeredAt = new Date().toISOString();
    this.send('access-answer', { id, answer, answeredAt: entry.answeredAt });
  }

  /** What is waiting now, and the last requests per session, for a window that (re)loads. */
  snapshot() {
    const perSession = new Map();
    for (const e of this.history) {
      const key = e.sessionId || '';
      const list = perSession.get(key) || [];
      list.push(e);
      if (list.length > HISTORY_LIMIT) list.shift();
      perSession.set(key, list);
    }
    return { pending: [...this.pending.values()], history: [...perSession.values()].flat() };
  }
}

function psTable() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(parsePs(err ? '' : stdout)));
  });
}

function pgrep(name) {
  return new Promise((resolve) => {
    // Exit 1 is "none running".
    execFile('/usr/bin/pgrep', ['-x', name], (err, stdout) => resolve(String(stdout || '').split('\n').map(Number).filter(Boolean)));
  });
}

module.exports = { AccessWatch, runningToolReason, shortText, parsePrompting, parseResult, parsePs, traceProcess, safeCommand, safeOpCommand, containerOf, describeService, SERVICE_LABELS };
