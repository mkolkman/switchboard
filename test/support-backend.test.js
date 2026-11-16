const test = require('node:test');
const assert = require('node:assert/strict');

const { BACKEND_METHODS, backendName, helpscoutHandlers } = require('../support-backend');

test('Help Scout stays the app unless Support Desk is picked', () => {
  assert.equal(backendName(undefined), 'helpscout');
  assert.equal(backendName('helpscout'), 'helpscout');
  assert.equal(backendName('something else'), 'helpscout');
  assert.equal(backendName('support-desk'), 'support-desk');
});

test('both apps answer every call the tab makes', () => {
  for (const [name, mod] of [['helpscout', require('../helpscout')], ['support-desk', require('../support-desk')]]) {
    for (const method of BACKEND_METHODS) assert.equal(typeof mod[method], 'function', `${name}.${method}`);
  }
});

/** A backend that records its calls and answers with its own name. */
function fake(name, calls) {
  return Object.fromEntries(BACKEND_METHODS.map(m => [m, async (...args) => {
    calls.push([name, m, ...args]);
    return m === 'openAttachment' ? { file: `/tmp/${name}` } : { from: name };
  }]));
}

test('each channel goes to the app picked at the time of the call', async () => {
  const calls = [];
  const backends = { helpscout: fake('helpscout', calls), 'support-desk': fake('support-desk', calls) };
  let picked = 'helpscout';
  const opened = [];
  const handlers = helpscoutHandlers({
    backend: () => backends[picked],
    attachmentDir: () => '/chats/.helpscout-attachments',
    openPath: async (file) => { opened.push(file); return ''; },
  });

  assert.deepEqual(await handlers['helpscout-inbox']({}), { ok: true, from: 'helpscout' });
  picked = 'support-desk';
  assert.deepEqual(await handlers['helpscout-inbox']({}), { ok: true, from: 'support-desk' });
  await handlers['helpscout-send-reply']({}, 1628, { text: 'Hi', status: 'closed' });
  await handlers['helpscout-assign']({}, 1628, 0);
  await handlers['helpscout-statuses']({}, 'not a list');
  await handlers['helpscout-draft-prompt']({}, 1628, undefined);
  assert.deepEqual(await handlers['helpscout-open-attachment']({}, 1628, 9, 'a.pdf'), { ok: true });
  assert.deepEqual(opened, ['/tmp/support-desk']);
  assert.deepEqual(calls.slice(1), [
    ['support-desk', 'getInbox'],
    ['support-desk', 'sendReply', 1628, { text: 'Hi', status: 'closed' }],
    ['support-desk', 'assign', 1628, null],
    ['support-desk', 'getStatuses', []],
    ['support-desk', 'getDraftPrompt', 1628, '', '/chats/.helpscout-attachments'],
    ['support-desk', 'openAttachment', 1628, 9, 'a.pdf'],
  ]);
});

test('a failing call answers { error }, also when it throws at once', async () => {
  const handlers = helpscoutHandlers({
    backend: () => ({ getConversation: () => { throw new Error('No token'); }, setStatus: async () => { throw new Error('Unknown status: x'); } }),
    attachmentDir: () => '/x',
    openPath: async () => 'No app for this file',
  });
  assert.deepEqual(await handlers['helpscout-conversation']({}, 1), { error: 'No token' });
  assert.deepEqual(await handlers['helpscout-set-status']({}, 1, 'x'), { error: 'Unknown status: x' });
});

test('an attachment that will not open answers the reason', async () => {
  const handlers = helpscoutHandlers({
    backend: () => ({ openAttachment: async () => ({ file: '/tmp/a.xyz' }) }),
    attachmentDir: () => '/x',
    openPath: async () => 'No app for this file',
  });
  assert.deepEqual(await handlers['helpscout-open-attachment']({}, 1, 2, 'a.xyz'), { error: 'No app for this file' });
});
