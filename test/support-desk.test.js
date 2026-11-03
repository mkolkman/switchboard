const test = require('node:test');
const assert = require('node:assert/strict');

const supportDesk = require('../support-desk');
const { shapeConversation, shapeThread, shapeDetail, baseUrl, DRAFT_THREAD_ID } = supportDesk;
const { draftPrompt } = require('../helpscout');

const summary = (extra = {}) => ({
  id: 41, number: 1628, subject: 'Account Link?', preview: 'Hi, how do I', status: 'active',
  mailbox: { id: 2, name: 'NOHRD' }, customer: { email: 'p@x.de', name: 'Petra' },
  assignee: { id: 8, name: 'Lars van Arkel' }, tags: ['nohrd'], last_message_at: '2026-10-14T08:00:00+00:00', ...extra,
});

test('a ticket summary becomes the conversation the tab lists, addressed by its number', () => {
  const conv = shapeConversation(summary(), 7);
  assert.equal(conv.id, 1628);
  assert.equal(conv.number, 1628);
  assert.equal(conv.group, 'assigned');
  assert.equal(conv.mailboxId, 2);
  assert.deepEqual(conv.assignee, { id: 8, name: 'Lars van Arkel' });
  assert.deepEqual(conv.customer, { id: null, name: 'Petra', email: 'p@x.de' });
  assert.deepEqual(conv.tags, ['nohrd']);
  assert.equal(conv.updatedAt, '2026-10-14T08:00:00+00:00');
  // The folders are Help Scout's.
  assert.equal(shapeConversation(summary({ assignee: null }), 7).group, 'unassigned');
  assert.equal(shapeConversation(summary({ assignee: { id: 7, name: 'Mike' }, status: 'pending' }), 7).group, 'mine');
  assert.equal(shapeConversation(summary({ status: 'closed' }), 7).group, 'closed');
  assert.equal(shapeConversation(summary({ status: 'spam' }), 7).group, 'spam');
  // A ticket without a contact still has a customer to show.
  assert.deepEqual(shapeConversation(summary({ customer: null, subject: '' }), 7).customer, { id: null, name: '', email: '' });
  assert.equal(shapeConversation(summary({ subject: '' }), 7).subject, '(no subject)');
});

test('timeline items become threads: customer, reply, forward, note by Claude, and activity lines', () => {
  const inbound = shapeThread({
    kind: 'message', id: 1, at: 't1', direction: 'in', is_forward: false, from: { email: 'p@x.de', name: 'Petra' },
    to: ['support@x'], cc: [], text: 'It stops.', sent_by: null,
    attachments: [{ id: 9, filename: 'a.jpg', mime_type: 'image/jpeg', size: 12, inline: false }, { id: 10, filename: 'logo.png', mime_type: 'image/png', size: 3, inline: true }],
  });
  assert.equal(inbound.type, 'customer');
  assert.equal(inbound.from, 'Petra');
  assert.equal(inbound.byCustomer, true);
  assert.equal(inbound.text, 'It stops.');
  // Inline images are part of the message, not files to open.
  assert.deepEqual(inbound.attachments, [{ id: 9, name: 'a.jpg', mimeType: 'image/jpeg', size: 12 }]);

  const reply = shapeThread({ kind: 'message', id: 2, at: 't2', direction: 'out', is_forward: false, from: { email: 'support@x', name: 'NOHRD Support' }, to: ['p@x.de'], text: 'Try this.', sent_by: 'Mike Kolkman', attachments: [] });
  assert.equal(reply.type, 'reply');
  assert.equal(reply.from, 'Mike Kolkman');
  assert.equal(reply.byCustomer, false);
  assert.equal(shapeThread({ kind: 'message', id: 3, direction: 'out', is_forward: true, from: { email: 'support@x' }, attachments: [] }).type, 'forwardchild');

  const note = shapeThread({ kind: 'note', id: 4, at: 't3', body: 'Look at MINC-3.', author: 'Mike Kolkman', author_id: 7, by_claude: true });
  assert.deepEqual([note.type, note.byClaude, note.from, note.text], ['note', true, 'Mike Kolkman', 'Look at MINC-3.']);
  assert.equal(shapeThread({ kind: 'note', id: 8, body: '\u{1F916} Written by Claude\n\nImported', by_claude: false }).byClaude, true);
  assert.equal(shapeThread({ kind: 'note', id: 9, body: 'By hand', by_claude: false }).byClaude, false);

  const line = shapeThread({ kind: 'activity', id: 5, at: 't4', type: 'assigned', data: { to: 'Lars' }, by: 'Mike' });
  assert.deepEqual([line.type, line.action], ['lineitem', 'Assigned to Lars by Mike']);
  assert.equal(shapeThread({ kind: 'activity', id: 6, type: 'tagged', data: { removed: 'x' }, by: null }).action, 'Removed tag x');
  assert.equal(shapeThread({ kind: 'activity', id: 7, type: 'something-new', data: {} }).action, 'something-new');
});

test('a whole ticket: newest first with the shared reply draft on top, and its page on Support Desk', () => {
  const conv = shapeDetail({
    ...summary(),
    url: 'https://desk.test/conversations/1628',
    reply_to: { to: ['p@x.de'], cc: ['boss@x.de'] },
    timeline: [
      { kind: 'message', id: 1, at: 't1', direction: 'in', from: { email: 'p@x.de', name: 'Petra' }, text: 'It stops.', attachments: [] },
      { kind: 'note', id: 2, at: 't2', body: 'check logs', author: 'Mike', by_claude: false },
    ],
    drafts: { reply: { to: ['p@x.de'], cc: [], bcc: [], body: 'Hi Petra', by_claude: true, author: 'Mike', updated_at: 't3' } },
  }, 7, [{ id: 1, conversation: 1628 }, { id: 2, conversation: 99 }]);
  assert.equal(conv.app, 'Support Desk');
  assert.equal(conv.url, 'https://desk.test/conversations/1628');
  assert.deepEqual(conv.cc, ['boss@x.de']);
  assert.deepEqual(conv.threads.map(t => [t.type, t.draft, t.text]), [['reply', true, 'Hi Petra'], ['note', false, 'check logs'], ['customer', false, 'It stops.']]);
  assert.equal(conv.threads[0].id, DRAFT_THREAD_ID);
  assert.equal(conv.threads[0].byClaude, true);
  assert.deepEqual(conv.suggestions.map(s => s.id), [1]);
  // No draft, no draft thread.
  assert.equal(shapeDetail({ ...summary(), timeline: [], drafts: {} }, 7).threads.length, 0);

  // A draft session's prompt names Support Desk, not Help Scout.
  const prompt = draftPrompt(conv);
  assert.match(prompt, /Write the reply to Support Desk ticket #1628 \(https:\/\/desk\.test\/conversations\/1628\)/);
  assert.match(prompt, /no Support Desk draft or note/);
  assert.doesNotMatch(prompt, /Hi Petra/);
});

test('baseUrl: the site address, whatever was pasted along with it', () => {
  assert.equal(baseUrl(' https://desk.test/ '), 'https://desk.test');
  assert.equal(baseUrl('https://desk.test/api/v1'), 'https://desk.test');
  assert.equal(baseUrl('https://desk.test/api/'), 'https://desk.test');
});

// --- Writes, against a stand-in for Support Desk ---

function fakeDesk(t, ticket) {
  const calls = [];
  const saved = { url: process.env.SUPPORT_DESK_URL, token: process.env.SUPPORT_DESK_TOKEN, fetch: global.fetch };
  process.env.SUPPORT_DESK_URL = 'https://desk.test/';
  process.env.SUPPORT_DESK_TOKEN = 'tok';
  global.fetch = async (url, init = {}) => {
    const call = { method: init.method || 'GET', url, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const json = call.method === 'GET' && /\/conversations\/\d+$/.test(url) ? ticket : call.method === 'GET' && url.endsWith('/me') ? { id: 7, name: 'Mike' } : {};
    if (url.includes('/attachments/')) return new Response(Buffer.from('PNG!'));
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    for (const [k, v] of [['SUPPORT_DESK_URL', saved.url], ['SUPPORT_DESK_TOKEN', saved.token]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    global.fetch = saved.fetch;
  });
  return calls;
}

const ticket = (drafts = {}) => ({ ...summary(), reply_to: { to: ['p@x.de'], cc: ['boss@x.de'] }, drafts, timeline: [] });

test('sendReply posts the reply to its default recipients, with the status to leave it in', async (t) => {
  const calls = fakeDesk(t, ticket());
  await supportDesk.sendReply(1628, { threadId: DRAFT_THREAD_ID, text: 'Hi Petra', status: 'closed' });
  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.url, 'https://desk.test/api/v1/conversations/1628/reply');
  assert.equal(post.auth, 'Bearer tok');
  assert.deepEqual(post.body, { to: ['p@x.de'], cc: ['boss@x.de'], bcc: [], body: 'Hi Petra', status: 'closed' });
  await assert.rejects(supportDesk.sendReply(1628, { text: '  ' }), /empty/);
  await assert.rejects(supportDesk.sendReply(1628, { text: 'x', status: 'spam' }), /Unknown status/);
});

test('a draft keeps the recipients someone set on it, when saved and when sent', async (t) => {
  const calls = fakeDesk(t, ticket({ reply: { to: ['other@x.de'], cc: [], bcc: ['me@x'], body: 'old' } }));
  assert.deepEqual(await supportDesk.saveDraft(1628, { text: 'new text' }), { threadId: DRAFT_THREAD_ID });
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.url, 'https://desk.test/api/v1/conversations/1628/drafts/reply');
  assert.deepEqual(put.body, { body: 'new text', to: ['other@x.de'], cc: [], bcc: ['me@x'] });
  await supportDesk.sendReply(1628, { text: 'new text' });
  assert.deepEqual(calls.find(c => c.method === 'POST').body, { to: ['other@x.de'], cc: [], bcc: ['me@x'], body: 'new text' });
});

test('assign, status, notes and attachments go to their own endpoints', async (t) => {
  const calls = fakeDesk(t, ticket());
  await supportDesk.assign(1628, 8);
  await supportDesk.assign(1628, null);
  await supportDesk.setStatus(1628, 'pending');
  await supportDesk.addNote(1628, '@lars could you look?');
  const { data } = await supportDesk.getAttachment(1628, 9);
  assert.deepEqual(calls.map(c => [c.method, c.url.replace('https://desk.test/api/v1', ''), c.body]), [
    ['PUT', '/conversations/1628/assignee', { assignee_id: 8 }],
    ['PUT', '/conversations/1628/assignee', { assignee_id: null }],
    ['PUT', '/conversations/1628/status', { status: 'pending' }],
    ['POST', '/conversations/1628/notes', { body: '@lars could you look?' }],
    ['GET', '/attachments/9', null],
  ]);
  assert.equal(Buffer.from(data, 'base64').toString(), 'PNG!');
  await assert.rejects(supportDesk.setStatus(1628, 'gone'), /Unknown status/);
});

test('a refusal reads as Support Desk words it', async (t) => {
  fakeDesk(t, ticket());
  global.fetch = async () => new Response(JSON.stringify({ message: 'invalid', errors: { 'to.0': ['The to.0 field must be a valid email address.'] } }), { status: 422 });
  await assert.rejects(supportDesk.addNote(1628, 'x'), /Support Desk: to\.0: The to\.0 field must be a valid email address\./);
  global.fetch = async () => new Response(JSON.stringify({ message: 'This token may not send.' }), { status: 403 });
  await assert.rejects(supportDesk.assign(1628, 1), /Support Desk: This token may not send\./);
});
