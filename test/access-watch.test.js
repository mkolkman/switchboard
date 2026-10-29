const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePrompting, parseResult, parsePs, traceProcess, safeCommand, safeOpCommand, describeService, AccessWatch } = require('../access-watch');

// As tccd logged them for a real dialog (2026-10-29).
const PROMPTING = 'AUTHREQ_PROMPTING: msgID=15011.574, service=kTCCServiceSystemPolicyAppData, subject=Sub:{ai.doctly.switchboard}Resp:{TCCDProcess: identifier=com.apple.ls, pid=66771, auid=501, euid=501, responsible_path=/Applications/Switchboard.app/Contents/MacOS/Switchboard, binary_path=/bin/ls},';
const RESULT = 'AUTHREQ_RESULT: msgID=15011.574, authValue=0, authReason=2, authVersion=1, desired_auth=0, error=(null),';

test('parsePrompting and parseResult: the dialog, who asked, and the answer', () => {
  assert.deepEqual(parsePrompting(PROMPTING), { msgId: '15011.574', subject: 'ai.doctly.switchboard', service: 'SystemPolicyAppData', pid: 66771 });
  assert.equal(parsePrompting(RESULT), null);
  assert.deepEqual(parseResult(RESULT), { msgId: '15011.574', allowed: false });
  assert.deepEqual(parseResult(RESULT.replace('authValue=0', 'authValue=2')), { msgId: '15011.574', allowed: true });
});

const PS = `
    1     0 /sbin/launchd
  879     1 /Applications/Switchboard.app/Contents/MacOS/Switchboard /Applications/Switchboard.app/Contents/Resources/app.asar/pty-daemon.js --socket x
  900   879 /bin/zsh -l -i -c claude --resume 553fb866-8f1e-495c-82ba-0a7ae210ec0d --mcp-config {}
  901   900 claude --resume 553fb866-8f1e-495c-82ba-0a7ae210ec0d --mcp-config {}
  950   901 /bin/zsh -c source snapshot && eval 'ls ~/Library/Group\\ Containers/2BUA8C4S2C.com.1password'
66771   950 ls -G /Users/me/Library/Group Containers/2BUA8C4S2C.com.1password
  700     1 /Applications/iTerm.app/Contents/MacOS/iTerm2
  710   700 -zsh
  711   710 op read op://Private/Bugsnag/token
`;

test('traceProcess: up the tree to the session whose claude it runs under', () => {
  const table = parsePs(PS);
  assert.deepEqual(traceProcess(table, 66771), { sessionId: '553fb866-8f1e-495c-82ba-0a7ae210ec0d', underApp: true, command: 'ls -G /Users/me/Library/Group Containers/2BUA8C4S2C.com.1password' });
  // An op in a terminal of its own is nobody's in Switchboard.
  assert.deepEqual(traceProcess(table, 711), { sessionId: null, underApp: false, command: 'op read op://Private/Bugsnag/token' });
  assert.equal(traceProcess(table, 711, { appPids: [700] }).underApp, true);
  assert.deepEqual(traceProcess(table, 4242), { sessionId: null, underApp: false, command: '' });
});

test('safeCommand: never the environment ps can run on into, escapes as spaces, cut short', () => {
  assert.equal(safeCommand('/x/op read\\012op://Private/Test/token OP_PLUGIN_ALIASES_SOURCED=1 GITHUB_TOKEN=ghp_secret'), '/x/op read op://Private/Test/token');
  assert.equal(safeCommand('file ~/Library/Containers/com.apple.mail'), 'file ~/Library/Containers/com.apple.mail');
  assert.equal(safeCommand('x'.repeat(400)).length, 300);
});

test('safeOpCommand and describeService: no values, and which app\'s data', () => {
  assert.equal(safeOpCommand('/x/op read\\012op://Private/Test/token password=geheim OP_SESSION=abc'), 'op read op://Private/Test/token');
  assert.equal(safeOpCommand('/opt/homebrew/bin/op read op://Private/Bugsnag/token'), 'op read op://Private/Bugsnag/token');
  assert.equal(safeOpCommand('op item create --category=login title=x password=hunter2 --vault Private'), 'op item create --vault Private');
  assert.equal(describeService('SystemPolicyAppData', 'ls -G /Users/me/Library/Group Containers/2BUA8C4S2C.com.1password'), 'data of another app (2BUA8C4S2C.com.1password)');
  assert.equal(describeService('SystemPolicyDownloadsFolder', 'cat ~/Downloads/x'), 'your Downloads folder');
  assert.equal(describeService('SomethingNew', ''), 'something new');
});

test('AccessWatch: a dialog of this app becomes a request, its answer closes it; other apps are ignored', async () => {
  const sent = [];
  const watch = new AccessWatch({ bundleId: 'ai.doctly.switchboard', send: (channel, payload) => sent.push([channel, payload]), log: {} });
  await watch.onLogMessage(PROMPTING.replace('ai.doctly.switchboard', 'com.googlecode.iterm2'));
  assert.equal(sent.length, 0);
  await watch.onLogMessage(PROMPTING);
  assert.equal(sent[0][0], 'access-request');
  assert.equal(sent[0][1].id, 'tcc:15011.574');
  assert.equal(sent[0][1].kind, 'tcc');
  assert.equal(watch.snapshot().pending.length, 1);
  await watch.onLogMessage(RESULT);
  assert.deepEqual([sent[1][0], sent[1][1].id, sent[1][1].answer], ['access-answer', 'tcc:15011.574', 'denied']);
  const snap = watch.snapshot();
  assert.equal(snap.pending.length, 0);
  assert.equal(snap.history[0].answer, 'denied');
});

test('panelBounds: centred just above the dialog, below it when there is no room, else at the top', () => {
  const { panelBounds, PANEL_WIDTH } = require('../access-panel');
  const work = { x: 0, y: 25, width: 1512, height: 957 };
  // The dialog of 2026-10-29: 298 wide at 607,171.
  assert.deepEqual(panelBounds({ x: 607, y: 171, width: 298, height: 286 }, 74, work), { x: 756 - PANEL_WIDTH / 2, y: 87, width: PANEL_WIDTH, height: 74 });
  assert.equal(panelBounds({ x: 607, y: 60, width: 298, height: 286 }, 74, work).y, 60 + 286 + 10);
  assert.deepEqual(panelBounds(null, 74, work), { x: (1512 - PANEL_WIDTH) / 2, y: 65, width: PANEL_WIDTH, height: 74 });
  // Never off the screen's side.
  assert.equal(panelBounds({ x: 0, y: 300, width: 100, height: 100 }, 74, work).x, 0);
});
