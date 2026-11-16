const { execFile } = require('child_process');
const helpscout = require('./helpscout');

// Support Desk, MoveLab's own support inbox that replaces Help Scout, read and
// written live through its HTTP API (docs/api.md in the Support-Desk repo) for
// the Help Scout tab. It returns the shapes helpscout.js returns, so the tab
// works the same on either (main.js picks one, support-backend.js). Tickets are
// addressed by number, so a conversation's id here is its number.
//
// The token is a "Switchboard token" made in Support Desk under Settings > API
// tokens: it may read, write, triage and send. It is kept in the keychain with
// the URL (services support-desk-url and support-desk-token) and read through
// /usr/bin/security, as the other tokens are, so a Claude session can use the
// same ones. SUPPORT_DESK_URL and SUPPORT_DESK_TOKEN override them.
//
// The suggestions to log later stay the customer-support skill's file
// (helpscout.js reads and writes it).

const APP = 'Support Desk';
const URL_SERVICE = 'support-desk-url';
const TOKEN_SERVICE = 'support-desk-token';
const ACCOUNT = 'support-desk';
const OPEN_PAGES = 5; // 100 per page: active and pending tickets
const RECENT = 25; // the most recent closed tickets, and spam
// The tab finds the draft among the threads by this id (saveDraft, sendReply ignore it).
const DRAFT_THREAD_ID = 'reply-draft';

// --- Credentials ---

function keychainRead(service) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim() || null);
    });
  });
}

function keychainWrite(service, value) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', value], { timeout: 10000 }, (err) => {
      if (err) reject(new Error(`Could not save to the keychain: ${err.message}`));
      else resolve();
    });
  });
}

/** The site's address without a trailing slash or the API path someone pasted along. */
const baseUrl = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');

async function credentials() {
  const [url, token] = await Promise.all([
    process.env.SUPPORT_DESK_URL || keychainRead(URL_SERVICE),
    process.env.SUPPORT_DESK_TOKEN || keychainRead(TOKEN_SERVICE),
  ]);
  return { url: url ? baseUrl(url) : null, token: token || null };
}

/** The URL and whether a token is set (never the token itself). */
async function getConfig() {
  const { url, token } = await credentials();
  return { url, hasToken: !!token };
}

/**
 * Save the URL, and the token when one is given (else the saved one stays),
 * after checking them with Support Desk: a Claude token cannot send or
 * assign, so it is refused here rather than on the first Send.
 */
async function saveConfig({ url, token }) {
  const base = baseUrl(url);
  if (!/^https?:\/\/[^/]/i.test(base)) throw new Error('The Support Desk URL must start with https://');
  const value = String(token || '').trim() || (await credentials()).token;
  if (!value) throw new Error('Paste a Support Desk API token (Settings > API tokens, "Switchboard token").');
  let res;
  try {
    res = await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${value}`, Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Support Desk is unreachable at ${base}: ${err.message}`);
  }
  if (res.status === 401) throw new Error('Support Desk does not accept this token.');
  if (!res.ok) throw new Error(`Support Desk answered ${res.status}.`);
  const me = await res.json().catch(() => ({}));
  if (!['send', 'triage'].every(a => (me.abilities || []).includes(a))) {
    throw new Error('This token cannot send or assign: make a "Switchboard token" in Support Desk.');
  }
  await keychainWrite(URL_SERVICE, base);
  if (String(token || '').trim()) await keychainWrite(TOKEN_SERVICE, value);
  cachedMe = null; // the token may be someone else's now
  return { url: base, hasToken: true };
}

// --- API ---

/** A refusal as one line: 422 names the fields, 403 says what the token may not do. */
function errorMessage(status, text) {
  try {
    const j = JSON.parse(text);
    const fields = Object.entries(j.errors || {}).map(([field, list]) => `${field}: ${[].concat(list).join(' ')}`);
    if (fields.length) return fields.join('; ');
    if (j.message) return j.message;
  } catch {}
  if (status === 401) return 'the token is not accepted (Settings > Support inbox).';
  return text.slice(0, 300) || String(status);
}

async function request(method, apiPath, body) {
  const { url, token } = await credentials();
  if (!url || !token) throw new Error('Support Desk is not connected yet: set its URL and token in Settings > Support inbox.');
  let res;
  try {
    res = await fetch(`${url}/api/v1${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Support Desk is unreachable: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Support Desk: ${errorMessage(res.status, await res.text())}`);
  return res;
}

async function api(method, apiPath, body) {
  const text = await (await request(method, apiPath, body)).text();
  return text.trim() ? JSON.parse(text) : null;
}

/** Every page of a folder, up to `max` pages. */
async function folder(name, perPage, max) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const data = await api('GET', `/conversations?folder=${name}&per_page=${perPage}&page=${page}`);
    out.push(...(data?.data || []));
    if (page >= (data?.meta?.last_page || 1)) break;
  }
  return out;
}

// --- Shapes: Support Desk's JSON as helpscout.js shapes it ---

function shapeConversation(c, meId) {
  return {
    id: c.number,
    number: c.number,
    subject: c.subject || '(no subject)',
    preview: c.preview || '',
    status: c.status,
    mailboxId: c.mailbox?.id ?? null,
    // Its folders are Help Scout's: spam and closed by status, the rest by assignee.
    group: helpscout.groupOf(c, meId),
    assignee: c.assignee?.id ? { id: c.assignee.id, name: c.assignee.name || '' } : null,
    customer: { id: null, name: c.customer?.name || '', email: c.customer?.email || '' },
    // No "waiting since" in a summary; the list falls back to the last message.
    waitingSince: null,
    updatedAt: c.last_message_at || null,
    tags: c.tags || [],
    url: c.url || null,
  };
}

/** An activity line as Support Desk's own timeline words it (activity-line.tsx). */
function describeActivity(a) {
  const d = a.data || {};
  const text = {
    created: () => (d.via === 'gmail' ? 'Started from Gmail' : d.via === 'new' ? 'Started as a new email' : 'Received'),
    reopened: () => 'Customer replied; reopened',
    assigned: () => (d.to ? `Assigned to ${d.to}` : 'Unassigned'),
    status: () => `Status set to ${d.to}`,
    tagged: () => (d.added ? `Tagged ${d.added}` : `Removed tag ${d.removed}`),
    forwarded: () => `Forwarded to ${d.to}`,
    imported: () => (d.merged ? `Merged with Help Scout #${d.helpscout_number}` : 'Imported from Help Scout'),
    helpscout: () => `${d.text} (in Help Scout)`,
  }[a.type];
  return `${text ? text() : a.type}${a.by ? ` by ${a.by}` : ''}`;
}

const addresses = (list) => (list || []).map(x => (typeof x === 'string' ? x : x?.email)).filter(Boolean);

/** One timeline item as a Help Scout thread: customer, reply, forward, note or lineitem. */
function shapeThread(item) {
  if (item.kind === 'note') {
    return {
      id: item.id, type: 'note', draft: false, from: item.author || '', fromEmail: '', byCustomer: false,
      // Notes imported from Help Scout carry the label helpscout_api.py put on Claude's notes instead.
      createdAt: item.at, text: item.body || '', byClaude: !!item.by_claude || String(item.body || '').startsWith(helpscout.CLAUDE_NOTE_LABEL),
      to: [], cc: [], attachments: [], action: null,
    };
  }
  if (item.kind === 'activity') {
    return {
      id: item.id, type: 'lineitem', draft: false, from: item.by || '', fromEmail: '', byCustomer: false,
      createdAt: item.at, text: '', byClaude: false, to: [], cc: [], attachments: [], action: describeActivity(item),
    };
  }
  const incoming = item.direction === 'in';
  return {
    id: item.id,
    type: incoming ? 'customer' : item.is_forward ? 'forwardchild' : 'reply',
    draft: false,
    // A reply comes from the mailbox; who wrote it is sent_by.
    from: (incoming ? null : item.sent_by) || item.from?.name || item.from?.email || (incoming ? 'Customer' : ''),
    fromEmail: item.from?.email || '',
    byCustomer: incoming,
    createdAt: item.at,
    text: item.text || '',
    byClaude: false,
    to: addresses(item.to),
    cc: addresses(item.cc),
    // Inline images are signature logos and the like, already part of the text.
    attachments: (item.attachments || []).filter(a => !a.inline).map(a => ({ id: a.id, name: a.filename, mimeType: a.mime_type || '', size: a.size || 0 })),
    action: null,
  };
}

/** The ticket's shared reply draft as the draft thread the tab looks for, or null. */
function shapeDraft(draft) {
  if (!draft) return null;
  return {
    id: DRAFT_THREAD_ID, type: 'reply', draft: true, from: draft.author || '', fromEmail: '', byCustomer: false,
    createdAt: draft.updated_at || null, text: draft.body || '', byClaude: !!draft.by_claude,
    to: draft.to || [], cc: draft.cc || [], bcc: draft.bcc || [], attachments: [], action: null,
  };
}

/** A whole ticket as getConversation returns it: threads newest first, the draft on top, as Help Scout lists them. */
function shapeDetail(c, meId, suggestions = []) {
  const draft = shapeDraft(c.drafts?.reply);
  return {
    ...shapeConversation(c, meId),
    app: APP,
    cc: c.reply_to?.cc || [],
    threads: [...(draft ? [draft] : []), ...(c.timeline || []).map(shapeThread).reverse()],
    suggestions: suggestions.filter(s => s.conversation === c.number),
  };
}

// --- Reading ---

let cachedMe = null;
async function me() {
  if (!cachedMe) cachedMe = api('GET', '/me').catch(err => { cachedMe = null; throw err; });
  return cachedMe;
}

/** Everything the sidebar shows: mailboxes, people to assign to, and the tickets by group. */
async function getInbox() {
  const user = await me();
  const [mailboxes, team, open, closed, spam] = await Promise.all([
    api('GET', '/mailboxes'),
    api('GET', '/team'),
    folder('open', 100, OPEN_PAGES),
    folder('closed', RECENT, 1),
    folder('spam', RECENT, 1),
  ]);
  return {
    app: APP,
    me: { id: user.id, name: user.name },
    mailboxes: (mailboxes || []).map(m => ({ id: m.id, name: m.name, email: m.email })),
    people: (team || []).map(u => ({ id: u.id, name: u.name, team: false, mention: u.handle || null })),
    // Open tickets come newest first; the tab lists them longest waiting first, as Help Scout's do.
    conversations: [...[...open].reverse(), ...closed, ...spam].map(c => shapeConversation(c, user.id)),
    suggestions: helpscout.readSuggestions(),
    fetchedAt: new Date().toISOString(),
  };
}

async function getConversation(number) {
  const user = await me();
  const conv = await api('GET', `/conversations/${Number(number)}`);
  return shapeDetail(conv, user.id, helpscout.readSuggestions());
}

/** The status of tickets by number: { [number]: 'active' | 'pending' | 'closed' | 'spam' }. */
async function getStatuses(numbers) {
  const unique = [...new Set(numbers.map(Number).filter(Boolean))];
  const found = await Promise.all(unique.map(n => api('GET', `/conversations/${n}`).then(c => [n, c?.status || null]).catch(() => [n, null])));
  return { statuses: Object.fromEntries(found.filter(([, status]) => status)) };
}

/** An attachment's bytes, base64. Its link wants the token, so the tab cannot load it itself. */
async function getAttachment(_number, attachmentId) {
  const res = await request('GET', `/attachments/${Number(attachmentId)}`);
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

const openAttachment = (number, attachmentId, name) => helpscout.openAttachment(number, attachmentId, name, getAttachment);
const saveAttachments = (conv, dir) => helpscout.saveAttachments(conv, dir, getAttachment);
const attachmentsPrompt = (saved) => helpscout.attachmentsPrompt(saved, APP);

async function getSessionAttachments(number, dir) {
  const saved = await saveAttachments(await getConversation(number), dir);
  return { ...saved, prompt: attachmentsPrompt(saved) };
}

/** The first message of a draft session (helpscout.js draftPrompt; the ticket says it is Support Desk's). */
async function getDraftPrompt(number, extra, dir) {
  const conv = await getConversation(number);
  return { prompt: helpscout.draftPrompt(conv, extra, await saveAttachments(conv, dir)) };
}

// --- Writes: each one is a click in the tab ---

/** The recipients a reply goes to: the draft's when it has them (someone may have changed them on the site), else the default ones. */
function recipients(conv) {
  const draft = conv.drafts?.reply;
  if (draft?.to?.length) return { to: draft.to, cc: draft.cc || [], bcc: draft.bcc || [] };
  return { to: conv.reply_to?.to || [], cc: conv.reply_to?.cc || [], bcc: [] };
}

/**
 * The ticket's one shared reply draft, with this text. Saving without
 * recipients would reset them to the defaults, so the draft's own go along.
 */
async function saveDraft(number, { text }) {
  if (!String(text || '').trim()) throw new Error('The reply is empty.');
  const conv = await api('GET', `/conversations/${Number(number)}`);
  await api('PUT', `/conversations/${Number(number)}/drafts/reply`, { body: String(text), ...recipients(conv) });
  return { threadId: DRAFT_THREAD_ID };
}

const STATUSES = ['active', 'pending', 'closed', 'spam'];

/** Send the reply now, leaving the ticket in `status`. Support Desk deletes the draft itself. */
async function sendReply(number, { text, status = null }) {
  if (!String(text || '').trim()) throw new Error('The reply is empty.');
  if (status && !['active', 'pending', 'closed'].includes(status)) throw new Error(`Unknown status: ${status}`);
  const conv = await api('GET', `/conversations/${Number(number)}`);
  const to = recipients(conv);
  if (!to.to.length) throw new Error('This ticket has nobody to reply to.');
  await api('POST', `/conversations/${Number(number)}/reply`, { ...to, body: String(text), ...(status ? { status } : {}) });
  return {};
}

/** A note for the team; an @handle in it mentions someone (Support Desk reads them itself). */
async function addNote(number, text) {
  if (!String(text || '').trim()) throw new Error('The note is empty.');
  await api('POST', `/conversations/${Number(number)}/notes`, { body: String(text) });
  return {};
}

/** Assign to a person by id, or unassign with null. */
async function assign(number, assigneeId) {
  await api('PUT', `/conversations/${Number(number)}/assignee`, { assignee_id: assigneeId ? Number(assigneeId) : null });
  return {};
}

async function setStatus(number, status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  await api('PUT', `/conversations/${Number(number)}/status`, { status });
  return {};
}

module.exports = {
  APP, DRAFT_THREAD_ID, baseUrl, shapeConversation, shapeThread, shapeDraft, shapeDetail, describeActivity,
  getConfig, saveConfig,
  getInbox, getConversation, getStatuses, getAttachment, openAttachment, saveAttachments, attachmentsPrompt, getSessionAttachments,
  draftPrompt: helpscout.draftPrompt, getDraftPrompt, splitDraftReply: helpscout.splitDraftReply,
  saveDraft, sendReply, addNote, assign, setStatus,
  readSuggestions: helpscout.readSuggestions, setSuggestionStatus: helpscout.setSuggestionStatus, asResult: helpscout.asResult,
};
