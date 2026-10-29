const test = require('node:test');
const assert = require('node:assert/strict');

const { htmlToText, textToHtml, groupOf, shapeConversation, shapeThread, draftPrompt, splitDraftReply, CLAUDE_NOTE_LABEL } = require('../helpscout');

test('thread bodies read as text, and typed text writes as Help Scout paragraphs', () => {
  assert.equal(htmlToText('<p>Hi Jens,</p><p>Thanks &amp; regards,<br>Mike</p><style>p{}</style>'), 'Hi Jens,\n\nThanks & regards,\nMike');
  assert.equal(htmlToText('caf&#233; &#x2764; &nbsp;ok'), 'café ❤  ok');
  assert.equal(textToHtml('Hi <Jens>,\n\nLine one\nline two\n\n\n'), 'Hi &lt;Jens&gt;,<br><br>Line one<br>line two');
  // Known handles become Help Scout mentions; other @words and e-mail addresses stay text.
  assert.equal(textToHtml('@niek could you look? cc @Lars, not @bob or a@niek.nl. Thanks @niek.', ['niek', 'lars']),
    '<span class="mention-highlight">@niek</span> could you look? cc <span class="mention-highlight">@Lars</span>, not @bob or a@niek.nl. Thanks <span class="mention-highlight">@niek</span>.');
});

test('conversations go where Help Scout files them', () => {
  const me = 7;
  assert.equal(groupOf({ status: 'active', assignee: null }, me), 'unassigned');
  assert.equal(groupOf({ status: 'pending', assignee: { id: 7 } }, me), 'mine');
  assert.equal(groupOf({ status: 'active', assignee: { id: 8 } }, me), 'assigned');
  assert.equal(groupOf({ status: 'closed', assignee: { id: 7 } }, me), 'closed');
  assert.equal(groupOf({ status: 'spam', assignee: null }, me), 'spam');
});

test('a conversation and its threads keep what the tab shows', () => {
  const conv = shapeConversation({
    id: 3481126808, number: 1628, subject: 'Account Link?', status: 'active', mailboxId: 1,
    assignee: { id: 8, first: 'Lars', last: 'van Arkel' }, primaryCustomer: { id: 5, first: 'Petra', email: 'p@x.de' },
    customerWaitingSince: { time: '2026-10-14T08:00:00Z' }, tags: [{ tag: 'nohrd' }], threads: 3,
  }, 7);
  assert.equal(conv.group, 'assigned');
  assert.deepEqual(conv.assignee, { id: 8, name: 'Lars van Arkel' });
  assert.deepEqual(conv.customer, { id: 5, name: 'Petra', email: 'p@x.de' });
  assert.equal(conv.url, 'https://secure.helpscout.net/conversation/3481126808/1628');
  assert.deepEqual(conv.tags, ['nohrd']);

  const note = shapeThread({ id: 1, type: 'note', state: 'published', body: `<b>${CLAUDE_NOTE_LABEL}</b><br><br>Look at MINC-3.`, createdBy: { type: 'user', first: 'Mike', last: 'Kolkman', email: 'm@x' }, createdAt: 't' });
  assert.equal(note.byClaude, true);
  assert.equal(note.from, 'Mike Kolkman');
  const draft = shapeThread({ id: 2, type: 'reply', state: 'draft', body: 'Hi', createdBy: { type: 'user', email: 'm@x' } });
  assert.equal(draft.draft, true);
  assert.equal(draft.from, 'm@x');
  // Attachments keep their id and type, for the API read; Help Scout's links need its token.
  const withFile = shapeThread({ id: 3, type: 'customer', body: 'See photo', _embedded: { attachments: [{ id: 9, filename: 'a.jpg', mimeType: 'image/jpeg', size: 12, _links: { web: { href: 'https://x' } } }] } });
  assert.deepEqual(withFile.attachments, [{ id: 9, name: 'a.jpg', mimeType: 'image/jpeg', size: 12 }]);
});

test('draftPrompt: the skill, your extra info, the ticket oldest first without drafts, and the reply alone at the end', () => {
  const thread = (id, type, text, extra = {}) => ({ id, type, text, from: 'Ann', createdAt: `2026-10-0${id}`, attachments: [], draft: false, ...extra });
  const conv = {
    number: 7, url: 'https://hs/7', subject: 'Rower stops', customer: { name: 'Ann', email: 'ann@x' },
    // Newest first, as Help Scout lists them.
    threads: [thread(3, 'reply', 'my draft', { draft: true }), thread(2, 'note', 'check logs'), thread(1, 'customer', 'It stops', { attachments: [{ name: 'a.jpg' }] })],
  };
  const prompt = draftPrompt(conv, '  He already has a new cable.  ');
  assert.ok(prompt.startsWith('/movelab-claude-skills:customer-support '));
  assert.match(prompt, /From me, to take into account:\nHe already has a new cable\.\n/);
  assert.match(prompt, /between <reply> and <\/reply>; notes for me go outside/);
  assert.doesNotMatch(draftPrompt(conv), /From me/);
  assert.ok(prompt.indexOf('It stops') < prompt.indexOf('check logs'));
  assert.match(prompt, /--- Customer, Ann, 2026-10-01 \(attached: a\.jpg\)/);
  assert.match(prompt, /--- Note \(team only\)/);
  assert.doesNotMatch(prompt, /my draft/);
});

test('splitDraftReply: the reply between its tags, notes around them, all of it without tags', () => {
  assert.deepEqual(splitDraftReply('I kept it short.\n\n<reply>\nHi Ann,\n\nThanks!\n</reply>\n\nSay if it is too short.'),
    { reply: 'Hi Ann,\n\nThanks!', notes: 'I kept it short.\n\n\n\nSay if it is too short.' });
  assert.deepEqual(splitDraftReply('Hi Ann,\n\nThanks!'), { reply: 'Hi Ann,\n\nThanks!', notes: '' });
  assert.deepEqual(splitDraftReply('```\nHi Ann\n```'), { reply: 'Hi Ann', notes: '' });
});

test('saveAttachments: a ticket\'s files in its own folder for a session, oldest first, drafts and huge files left out', async () => {
  const { saveAttachments, attachmentsPrompt } = require('../helpscout');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-att-'));
  // Already saved, so nothing is read from Help Scout.
  fs.mkdirSync(path.join(dir, '7'));
  for (const f of ['9-shot 1.png', '8-log.txt', '6-old.jpg']) fs.writeFileSync(path.join(dir, '7', f), 'x');
  const thread = (id, extra) => ({ id, type: 'customer', from: 'Ann', createdAt: `2026-10-0${id}`, draft: false, attachments: [], ...extra });
  const conv = {
    id: 70, number: 7,
    threads: [
      thread(3, { draft: true, attachments: [{ id: 5, name: 'mine.png', size: 1 }] }),
      thread(2, { attachments: [{ id: 9, name: 'shot 1.png', size: 1 }, { id: 8, name: '../log.txt', size: 1 }, { id: 4, name: 'video.mov', size: 26 * 1024 * 1024 }] }),
      thread(1, { attachments: [{ id: 6, name: 'old.jpg', size: 1 }] }),
    ],
  };
  const saved = await saveAttachments(conv, dir);
  assert.deepEqual(saved.files.map(f => path.basename(f.path)), ['6-old.jpg', '9-shot 1.png', '8-log.txt']);
  assert.deepEqual(saved.skipped, [{ name: 'video.mov', why: 'over 25 MB' }]);
  const prompt = attachmentsPrompt(saved);
  assert.match(prompt, /Read tool/);
  assert.ok(prompt.includes(`- ${path.join(dir, '7', '9-shot 1.png')} (shot 1.png, from Ann, 2026-10-02)`));
  assert.match(prompt, /- video\.mov: not saved \(over 25 MB\)/);
  assert.equal(attachmentsPrompt({ files: [], skipped: [] }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
