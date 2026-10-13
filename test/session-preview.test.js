const test = require('node:test');
const assert = require('node:assert/strict');
const { lastAssistantMessage } = require('../session-preview');

test('returns the final assistant text and ignores later tool-only records', () => {
  const entries = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Next request' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
  ];

  assert.deepEqual(lastAssistantMessage(entries), { text: 'Final answer', truncated: false });
});

test('joins text blocks while excluding thinking and tool calls', () => {
  const entries = [{
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: 'First paragraph' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: 'Second paragraph' },
    ] },
  }];

  assert.deepEqual(lastAssistantMessage(entries), { text: 'First paragraph\n\nSecond paragraph', truncated: false });
});

test('supports string content, empty input, and bounded previews', () => {
  assert.deepEqual(lastAssistantMessage(null), { text: '', truncated: false });
  assert.deepEqual(lastAssistantMessage([{ type: 'assistant', message: { content: '  hello  ' } }]), { text: 'hello', truncated: false });
  assert.deepEqual(lastAssistantMessage([{ type: 'assistant', message: { content: '123456' } }], 4), { text: '1234', truncated: true });
});

const { currentActivity } = require('../session-preview');

test('currentActivity describes the latest step of the agent', () => {
  const turn = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const tool = (name, input) => ({ type: 'tool_use', name, input });
  assert.equal(currentActivity([turn(tool('Bash', { command: 'git rebase origin/main', description: 'Rebase onto main' }))]), 'Running: Rebase onto main');
  assert.equal(currentActivity([turn(tool('Bash', { command: 'git status' }))]), 'Running `git status`');
  assert.equal(currentActivity([turn(tool('Edit', { file_path: '/Users/me/Sources/mlc/app/Console/Commands/Migrate.php' }))]), 'Editing …/Console/Commands/Migrate.php');
  assert.equal(currentActivity([turn(tool('TodoWrite', { todos: [
    { content: 'Rebase', status: 'completed', activeForm: 'Rebasing' },
    { content: 'Resolve Migrate.php', status: 'in_progress', activeForm: 'Resolving conflict in Migrate.php' },
  ] }))]), 'Resolving conflict in Migrate.php');
  assert.equal(currentActivity([turn({ type: 'thinking', thinking: '…' })]), 'Thinking…');
  assert.equal(currentActivity([turn({ type: 'text', text: 'Rebased cleanly.' }), { type: 'user', message: { role: 'user', content: 'ok' } }]), '', 'text is the last message, shown on its own');
  assert.equal(currentActivity([turn({ type: 'text', text: 'Now the tests.' }, tool('Bash', { command: 'make test' }))]), 'Running `make test`', 'the latest block wins');
  assert.equal(currentActivity([]), '');
});
