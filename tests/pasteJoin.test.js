const test = require('node:test');
const assert = require('node:assert');
const { canJoin, joinLines } = require('../pasteText');

test('canJoin: an inline comment before a later line blocks the join', () => {
  assert.strictEqual(canJoin('Remove-Item .\\out -Recurse   # clean\nnpm run build'), false);
  assert.strictEqual(canJoin('npm i\nnpm test # a comment on the last line is fine'), true);
  assert.strictEqual(canJoin('# whole-line comment\nnpm i\nnpm test'), true);
});

test('canJoin: # inside quotes, mid-token or escaped is not a comment', () => {
  assert.strictEqual(canJoin('Write-Host "a # b"\nnext'), true);
  assert.strictEqual(canJoin("echo 'x #y'\nnext"), true);
  // A URL fragment blocks too: '#' after a quoted URL or a statement would be a comment.
  assert.strictEqual(canJoin('curl https://x/#frag\nnext'), false);
  assert.strictEqual(canJoin('$u = "https://x"#c\nnext'), false);
  assert.strictEqual(canJoin('$u="https://x";$v=2#c\nnext'), false);
  assert.strictEqual(canJoin('echo a `#b\nnext'), true);
});

test('canJoin: # right after ; } ) | also starts a comment', () => {
  assert.strictEqual(canJoin('$a=1;# c\nWrite-Host ok'), false);
  assert.strictEqual(canJoin('foreach ($f in $x) {\n  Remove-Item $f\n}# end\nWrite-Host ok'), false);
  assert.strictEqual(canJoin('(1+2)# c\nnext'), false);
  assert.strictEqual(canJoin('gci |# c\nselect'), false);
  assert.strictEqual(canJoin('Write-Host #tag\nnext'), false);
  // Expression mode: '#' right after a value is a comment, so any unquoted '#' blocks.
  assert.strictEqual(canJoin('$a = $x#c\nnext'), false);
  assert.strictEqual(canJoin('$a = 2#c\nnext'), false);
  assert.strictEqual(canJoin('Write-Host a#b\nnext'), false);
});

test('canJoin: typographic quotes count as quotes', () => {
  assert.strictEqual(canJoin('$s = “l1\n# keep\n”'), false);
  assert.strictEqual(canJoin('Write-Host “a # b”\nnext'), true);
  assert.strictEqual(canJoin("Write-Host ‘a # b’\nnext"), true);
});

test('canJoin: a string spanning lines is never joined', () => {
  assert.strictEqual(canJoin('$s = "l1\n# keep\nl3"'), false);
  assert.strictEqual(canJoin("$s = 'a\nb'"), false);
  assert.strictEqual(canJoin('Write-Host "a""b"\nnext'), true);
  assert.strictEqual(canJoin('Write-Host "a`"b"\nnext'), true);
});

test('canJoin: here-strings are never joined', () => {
  assert.strictEqual(canJoin("$s = @'\nline\n'@"), false);
  assert.strictEqual(canJoin('$s = @"\nline\n"@'), false);
});

test('joinLines: plain join keeps # lines and drops blanks', () => {
  assert.strictEqual(joinLines('# Rubrik\r\n\n  text  \nmer'), '# Rubrik text mer');
  assert.strictEqual(joinLines('\n  \n'), '');
});
