const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Help Scout, read and written live through the Mailbox API v2, for the Help
// Scout tab. It shares its login and files with the customer-support skill's
// helpscout_api.py (and the drafts job that runs it): the app's OAuth
// credentials in the keychain, the access token cache, and the suggestions
// to log later. Nothing here sends an email: a reply is always a draft, sent
// by you in Help Scout itself (the API cannot publish a draft).

const BASE = 'https://api.helpscout.net/v2';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'helpscout');
const TOKEN_FILE = path.join(CACHE_DIR, 'token.json');
const SUGGESTIONS_FILE = path.join(CACHE_DIR, 'suggestions.json');
const OPEN_PAGES = 8; // 25 per page: active and pending conversations
const CONVERSATION_URL = (id, number) => `https://secure.helpscout.net/conversation/${id}/${number}`;
// helpscout_api.py labels the notes it posts under your account the same way.
const CLAUDE_NOTE_LABEL = '\u{1F916} Written by Claude';

// --- Text ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A thread body as plain text: paragraphs and line breaks kept, tags gone (helpscout_api.py to_text). */
function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<\/p>|<\/div>/gi, '\n\n');
  h = h.replace(/<br\s*\/?>|<\/li>/gi, '\n');
  h = h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '');
  h = h.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return h.replace(/\n{3,}/g, '\n\n').trim();
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Text you typed as a thread body: paragraphs a blank line apart, as Help Scout's editor shows them (helpscout_api.py to_html). */
/**
 * Plain text as Help Scout HTML. `mentions` are user handles ("niek"): an
 * @handle among them is marked up the way Help Scout's own editor does.
 */
function textToHtml(text, mentions = []) {
  const known = new Set(mentions.map(m => String(m).toLowerCase()));
  const paras = String(text || '').trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => escapeHtml(p).replace(/\n/g, '<br>')
    .replace(/(^|[\s(])@([\w-]+)/g, (all, pre, handle) => (known.has(handle.toLowerCase()) ? `${pre}<span class="mention-highlight">@${handle}</span>` : all)))
    .join('<br><br>');
}

// --- Shapes ---

// Threads and conversations say first/last; users say firstName/lastName.
const personName = (p) => [p?.first ?? p?.firstName, p?.last ?? p?.lastName].filter(Boolean).join(' ') || p?.email || '';

/**
 * Where a conversation goes, as in Help Scout's own folders: spam and closed
 * by status, the rest by who it is assigned to.
 */
function groupOf(conv, meId) {
  if (conv.status === 'spam') return 'spam';
  if (conv.status === 'closed') return 'closed';
  const id = conv.assignee?.id;
  if (!id) return 'unassigned';
  return id === meId ? 'mine' : 'assigned';
}

function shapeConversation(c, meId) {
  const customer = c.primaryCustomer || {};
  return {
    id: c.id,
    number: c.number,
    subject: c.subject || '(no subject)',
    preview: c.preview || '',
    status: c.status,
    mailboxId: c.mailboxId,
    group: groupOf(c, meId),
    assignee: c.assignee?.id ? { id: c.assignee.id, name: personName(c.assignee) } : null,
    customer: { id: customer.id || null, name: personName(customer), email: customer.email || '' },
    waitingSince: c.customerWaitingSince?.time || null,
    updatedAt: c.userUpdatedAt || c.createdAt || null,
    tags: (c.tags || []).map(t => t.tag),
    threads: c.threads || 0,
    url: CONVERSATION_URL(c.id, c.number),
  };
}

function shapeThread(t) {
  const text = htmlToText(t.body);
  const by = t.createdBy || {};
  return {
    id: t.id,
    type: t.type,
    draft: t.state === 'draft',
    from: personName(by) || (t.type === 'customer' ? 'Customer' : ''),
    fromEmail: by.email || '',
    byCustomer: by.type === 'customer',
    createdAt: t.createdAt,
    text,
    // A note the skill or this tab wrote for Claude: the label opens it.
    byClaude: t.type === 'note' && text.startsWith(CLAUDE_NOTE_LABEL),
    to: t.to || [],
    cc: t.cc || [],
    // Help Scout's links need its API token; the tab fetches the file itself (getAttachment).
    attachments: (t._embedded?.attachments || []).map(a => ({ id: a.id, name: a.filename, mimeType: a.mimeType || '', size: a.size || 0 })),
    action: t.action?.text || null,
  };
}

// --- API ---

function keychain(service) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 10000 }, (err, stdout) => {
      const value = String(stdout || '').trim();
      if (err || !value) reject(new Error(`No Help Scout credential in the keychain ("${service}"). See helpscout_api.py in the customer-support skill.`));
      else resolve(value);
    });
  });
}

async function credential(env, service) {
  return process.env[env] || keychain(service);
}

let tokenPromise = null;

/** The access token, from the cache the skill's script shares, or a new one written back there. */
function accessToken() {
  try {
    const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (cached.expires_at > Date.now() / 1000 + 60) return Promise.resolve(cached.access_token);
  } catch {}
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: await credential('HELPSCOUT_APP_ID', 'helpscout-app-id'),
        client_secret: await credential('HELPSCOUT_APP_SECRET', 'helpscout-app-secret'),
      });
      const res = await fetch(`${BASE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) throw new Error(`Help Scout refused the login (${res.status}).`);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: json.access_token, expires_at: Date.now() / 1000 + Number(json.expires_in || 7200) }), { mode: 0o600 });
      return json.access_token;
    })().finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

async function api(method, apiPath, body) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const res = await fetch(BASE + apiPath, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) { try { fs.unlinkSync(TOKEN_FILE); } catch {} continue; }
    if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000)); continue; }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try { const j = JSON.parse(text); message = j._embedded?.errors?.map(e => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ') || j.message || message; } catch {}
      throw new Error(`Help Scout: ${message || res.status}`);
    }
    return { headers: res.headers, data: text.trim() ? JSON.parse(text) : null };
  }
}

let cachedMe = null;
async function me() {
  if (!cachedMe) cachedMe = api('GET', '/users/me').then(r => r.data).catch(err => { cachedMe = null; throw err; });
  return cachedMe;
}

async function pages(apiPath, key, max) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const { data } = await api('GET', `${apiPath}${apiPath.includes('?') ? '&' : '?'}page=${page}`);
    out.push(...(data?._embedded?.[key] || []));
    if (page >= (data?.page?.totalPages || 1)) break;
  }
  return out;
}

/** Everything the sidebar shows: mailboxes, people to assign to, and the conversations by group. */
async function getInbox() {
  const user = await me();
  const [mailboxes, users, teams, open, closed, spam] = await Promise.all([
    pages('/mailboxes', 'mailboxes', 4),
    pages('/users', 'users', 4),
    pages('/teams', 'teams', 2).catch(() => []),
    pages('/conversations?status=open&sortField=waitingSince&sortOrder=asc', 'conversations', OPEN_PAGES),
    pages('/conversations?status=closed&sortField=modifiedAt&sortOrder=desc', 'conversations', 1),
    pages('/conversations?status=spam&sortField=modifiedAt&sortOrder=desc', 'conversations', 1),
  ]);
  return {
    me: { id: user.id, name: personName(user) },
    mailboxes: mailboxes.map(m => ({ id: m.id, name: m.name, email: m.email })),
    people: [
      ...users.map(u => ({ id: u.id, name: personName(u), team: false, mention: u.mention || null })),
      ...teams.map(t => ({ id: t.id, name: t.name || personName(t), team: true, mention: t.mention || null })),
    ],
    conversations: [...open, ...closed, ...spam].map(c => shapeConversation(c, user.id)),
    suggestions: readSuggestions(),
    fetchedAt: new Date().toISOString(),
  };
}

/** One conversation with every thread, newest first, as Help Scout lists them. */
async function getConversation(id) {
  const user = await me();
  const [{ data: conv }, threads] = await Promise.all([
    api('GET', `/conversations/${Number(id)}`),
    pages(`/conversations/${Number(id)}/threads`, 'threads', 10),
  ]);
  return {
    ...shapeConversation(conv, user.id),
    cc: conv.cc || [],
    threads: threads.filter(t => t.type !== 'lineitem' || t.action?.text).map(shapeThread),
    suggestions: readSuggestions().filter(s => s.conversation === conv.id),
  };
}

/** An attachment's bytes, base64, read through the API (its web link wants a signed-in browser). */
async function getAttachment(conversationId, attachmentId) {
  const { data } = await api('GET', `/conversations/${Number(conversationId)}/attachments/${Number(attachmentId)}/data`);
  if (!data?.data) throw new Error('Help Scout returned no data for this attachment.');
  return { data: data.data };
}

/** A non-image attachment: written to a temp folder and opened in its default app. */
async function openAttachment(conversationId, attachmentId, name) {
  const { data } = await getAttachment(conversationId, attachmentId);
  const dir = path.join(os.tmpdir(), 'switchboard-helpscout');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(String(name || 'attachment')).replace(/[^\w.\- ]+/g, '_') || 'attachment';
  const file = path.join(dir, `${Number(attachmentId)}-${safe}`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return { file };
}

// --- A draft reply written by Claude, in a session of its own ---

const DRAFT_SKILL = '/movelab-claude-skills:customer-support';
const DRAFT_LABELS = { customer: 'Customer', message: 'Reply', reply: 'Reply', note: 'Note (team only)', forwardparent: 'Forwarded', forwardchild: 'Forward', chat: 'Chat', phone: 'Phone' };

/**
 * The first message of a draft session: the skill, what you added, the ticket
 * as text (oldest first) and what to hand back. The tab takes the reply out
 * of the session's last message, between <reply> tags (splitDraftReply).
 */
function draftPrompt(conv, extra = '') {
  const threads = [...conv.threads].reverse().filter(t => !t.draft && t.type !== 'lineitem');
  const customer = [conv.customer?.name, conv.customer?.email && `<${conv.customer.email}>`].filter(Boolean).join(' ');
  const note = String(extra || '').trim();
  return `${DRAFT_SKILL} Write the reply to Help Scout ticket #${conv.number} (${conv.url}).\n\n`
    + (note ? `From me, to take into account:\n${note}\n\n` : '')
    + 'In your last message, put the text of the reply between <reply> and </reply>; notes for me go outside '
    + 'those tags. Switchboard puts what is between them into the reply box, where it is checked and saved as '
    + 'a draft by hand. Do not post, save or log anything yourself (no Help Scout draft or note, no GitHub, no '
    + 'Notion) unless I ask for it here.\n\n'
    + `Subject: ${conv.subject}\nCustomer: ${customer}\n\nThe conversation, oldest first:\n\n`
    + threads.map(t => `--- ${DRAFT_LABELS[t.type] || t.type}${t.from ? `, ${t.from}` : ''}${t.createdAt ? `, ${t.createdAt}` : ''}`
      + `${t.attachments.length ? ` (attached: ${t.attachments.map(a => a.name).join(', ')})` : ''}\n${t.text}`).join('\n\n');
}

/**
 * A draft session's last message as { reply, notes }: the text between the
 * last <reply> tags, and what is around them. Without tags it is all reply.
 */
function splitDraftReply(message) {
  const text = String(message || '').trim();
  const tagged = [...text.matchAll(/<reply>\s*([\s\S]*?)\s*<\/reply>/gi)].pop();
  if (!tagged) return { reply: text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim(), notes: '' };
  const notes = (text.slice(0, tagged.index) + text.slice(tagged.index + tagged[0].length)).trim();
  return { reply: tagged[1].trim(), notes };
}

/** The first message of a draft session for a ticket, read fresh. */
async function getDraftPrompt(id, extra) {
  return { prompt: draftPrompt(await getConversation(id), extra) };
}

// --- Writes: each one is a click in the tab ---

/** Your draft reply: its text replaced when it exists, else a new draft. Never sent. */
async function saveDraft(id, { threadId = null, text }) {
  if (!String(text || '').trim()) throw new Error('The reply is empty.');
  if (threadId) {
    await api('PATCH', `/conversations/${Number(id)}/threads/${Number(threadId)}`, { op: 'replace', path: '/text', value: textToHtml(text) });
    return { threadId };
  }
  const { data: conv } = await api('GET', `/conversations/${Number(id)}`);
  const customerId = conv.primaryCustomer?.id;
  if (!customerId) throw new Error('This conversation has no customer to reply to.');
  const { headers } = await api('POST', `/conversations/${Number(id)}/reply`, { customer: { id: customerId }, text: textToHtml(text), draft: true });
  return { threadId: Number(headers.get('resource-id')) || null };
}

async function addNote(id, text) {
  if (!String(text || '').trim()) throw new Error('The note is empty.');
  const users = await pages('/users', 'users', 4);
  await api('POST', `/conversations/${Number(id)}/notes`, { text: textToHtml(text, users.map(u => u.mention).filter(Boolean)) });
  return {};
}

/** Assign to a person or team by id, or unassign with null. */
async function assign(id, assigneeId) {
  const body = assigneeId ? { op: 'replace', path: '/assignTo', value: Number(assigneeId) } : { op: 'remove', path: '/assignTo' };
  await api('PATCH', `/conversations/${Number(id)}`, body);
  return {};
}

const STATUSES = ['active', 'pending', 'closed', 'spam'];
async function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  await api('PATCH', `/conversations/${Number(id)}`, { op: 'replace', path: '/status', value: status });
  return {};
}

// --- Suggestions to log later (helpscout_api.py suggest / close) ---

function readSuggestions() {
  try { return JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8')); } catch { return []; }
}

/** Mark a suggestion logged or dismissed, written the way the script writes the file. */
function setSuggestionStatus(sid, status) {
  if (!['logged', 'dismissed', 'open'].includes(status)) throw new Error(`Unknown status: ${status}`);
  const items = readSuggestions();
  const item = items.find(i => String(i.id) === String(sid));
  if (!item) throw new Error(`No suggestion ${sid}.`);
  item.status = status;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${SUGGESTIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
  fs.renameSync(tmp, SUGGESTIONS_FILE);
  return { suggestions: items };
}

/** Run a call for the renderer; errors become { error } like the rest of IPC. */
function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

module.exports = {
  htmlToText, textToHtml, groupOf, shapeConversation, shapeThread, CLAUDE_NOTE_LABEL,
  getInbox, getConversation, getAttachment, openAttachment, draftPrompt, getDraftPrompt, splitDraftReply, saveDraft, addNote, assign, setStatus, readSuggestions, setSuggestionStatus, asResult,
};
