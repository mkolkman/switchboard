const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTerminalFont, DEFAULT_TERMINAL_FONT_FAMILY: DEFAULT_FAMILY } = require('../public/terminal-manager');

test('unset font settings fall back to the defaults', () => {
  assert.deepEqual(normalizeTerminalFont(), {
    fontFamily: DEFAULT_FAMILY,
    fontSize: 12,
    lineHeight: 1,
  });
  assert.deepEqual(normalizeTerminalFont({ fontFamily: '', fontSize: undefined, lineHeight: null }), {
    fontFamily: DEFAULT_FAMILY,
    fontSize: 12,
    lineHeight: 1,
  });
});

test('a blank/whitespace font family never reaches xterm', () => {
  // An empty family would leave the terminal with no font stack at all.
  assert.equal(normalizeTerminalFont({ fontFamily: '   ' }).fontFamily, DEFAULT_FAMILY);
});

test('the chosen family keeps the default monospace stack behind it', () => {
  // A family the browser can't resolve is not a CSS error: it silently falls back to
  // the default PROPORTIONAL font, which wrecks the terminal's column alignment.
  assert.equal(normalizeTerminalFont({ fontFamily: '  Menlo  ' }).fontFamily, 'Menlo, ' + DEFAULT_FAMILY);
  assert.equal(normalizeTerminalFont({ fontFamily: "'Mono Lisa'" }).fontFamily, "'Mono Lisa', " + DEFAULT_FAMILY);
  // Every stack must end in a monospace font, whatever the user typed.
  assert.match(normalizeTerminalFont({ fontFamily: 'kapot' }).fontFamily, /monospace$/);
});

test('the default stack is not appended to itself', () => {
  assert.equal(normalizeTerminalFont({ fontFamily: DEFAULT_FAMILY }).fontFamily, DEFAULT_FAMILY);
});

test('numeric settings arrive from number inputs as strings', () => {
  const font = normalizeTerminalFont({ fontSize: '14', lineHeight: '1.25' });
  assert.equal(font.fontSize, 14);
  assert.equal(font.lineHeight, 1.25);
});

test('line height is clamped to at least 1, as xterm throws below that', () => {
  assert.equal(normalizeTerminalFont({ lineHeight: 0.8 }).lineHeight, 1);
  assert.equal(normalizeTerminalFont({ lineHeight: -2 }).lineHeight, 1);
  assert.equal(normalizeTerminalFont({ lineHeight: 99 }).lineHeight, 3);
});

test('font size is clamped to a legible range', () => {
  assert.equal(normalizeTerminalFont({ fontSize: 2 }).fontSize, 6);
  assert.equal(normalizeTerminalFont({ fontSize: 500 }).fontSize, 32);
});

test('garbage values fall back instead of producing NaN', () => {
  const font = normalizeTerminalFont({ fontSize: 'abc', lineHeight: 'x' });
  assert.equal(font.fontSize, 12);
  assert.equal(font.lineHeight, 1);
});
