const test = require('node:test');
const assert = require('node:assert');
const { toOneLine, isMultiline } = require('../pasteText');

test('toOneLine: CRLF and CR are joined', () => {
  assert.strictEqual(toOneLine('a\r\nb\r\nc'), 'a b c');
  assert.strictEqual(toOneLine('a\rb'), 'a b');
});

test('toOneLine: trailing backtick continuation is stripped', () => {
  assert.strictEqual(toOneLine('Get-ChildItem `\n  -Recurse `\n  -Force'), 'Get-ChildItem -Recurse -Force');
  assert.strictEqual(toOneLine('a `  \r\nb'), 'a b');
});

test('toOneLine: comment lines dropped, block comment markers kept', () => {
  assert.strictEqual(toOneLine('# setup\ncd x\n  # note\nls'), 'cd x ls');
  assert.strictEqual(toOneLine('<#\n#>\nls'), '<# #> ls');
  assert.strictEqual(toOneLine('<# a\n  #> ls'), '<# a #> ls');
});

test('toOneLine: blank lines dropped', () => {
  assert.strictEqual(toOneLine('a\n\n   \nb\n'), 'a b');
});

test('toOneLine: single line unchanged', () => {
  assert.strictEqual(toOneLine('git status --short'), 'git status --short');
});

test('toOneLine: only a trailing newline', () => {
  assert.strictEqual(toOneLine('cmd\n'), 'cmd');
  assert.strictEqual(toOneLine('cmd\r\n'), 'cmd');
});

test('toOneLine: indentation trimmed on every line', () => {
  assert.strictEqual(toOneLine('if ($x) {\n    Write-Host hi\n\t}'), 'if ($x) { Write-Host hi }');
});

test('toOneLine: only comments gives empty string', () => {
  assert.strictEqual(toOneLine('# a\n# b\n'), '');
  assert.strictEqual(toOneLine(''), '');
});

test('isMultiline', () => {
  assert.strictEqual(isMultiline('a\nb'), true);
  assert.strictEqual(isMultiline('a\r\nb'), true);
  assert.strictEqual(isMultiline('a\rb'), true);
  assert.strictEqual(isMultiline('cmd\n'), false);
  assert.strictEqual(isMultiline('cmd\r\n\r\n'), false);
  assert.strictEqual(isMultiline('cmd'), false);
  assert.strictEqual(isMultiline(''), false);
});
