const test = require('node:test');
const assert = require('node:assert');
const ni = require('../noteImages');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF87 = Buffer.from('GIF87a\x01\x00', 'latin1');
const GIF89 = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const b64 = (buf) => buf.toString('base64');

test('magic bytes match each declared type', () => {
  assert.ok(ni.magicMatches(PNG, 'png'));
  assert.ok(ni.magicMatches(JPG, 'jpg'));
  assert.ok(ni.magicMatches(GIF87, 'gif'));
  assert.ok(ni.magicMatches(GIF89, 'gif'));
  assert.ok(ni.magicMatches(WEBP, 'webp'));
});

test('checkImageData accepts each type and maps the media type to an ext', () => {
  for (const [buf, mt, ext] of [[PNG, 'image/png', 'png'], [JPG, 'image/jpeg', 'jpg'],
    [GIF89, 'image/gif', 'gif'], [WEBP, 'image/webp', 'webp']]) {
    const r = ni.checkImageData(b64(buf), mt);
    assert.strictEqual(r.ok, true, mt);
    assert.strictEqual(r.ext, ext);
    assert.ok(r.buf.equals(buf));
  }
});

test('mismatched magic bytes are rejected', () => {
  assert.strictEqual(ni.magicMatches(PNG, 'jpg'), false);
  assert.strictEqual(ni.magicMatches(JPG, 'png'), false);
  assert.strictEqual(ni.magicMatches(Buffer.from('GIF88a'), 'gif'), false);
  assert.strictEqual(ni.magicMatches(Buffer.from('RIFF\0\0\0\0WAVE'), 'webp'), false);
  assert.strictEqual(ni.magicMatches(Buffer.from([0x89, 0x50]), 'png'), false); // too short
  assert.strictEqual(ni.checkImageData(b64(PNG), 'image/jpeg').ok, false);
  assert.strictEqual(ni.checkImageData(b64(Buffer.from('<svg/>')), 'image/png').ok, false);
});

test('unsupported media types and non-string data are rejected', () => {
  assert.strictEqual(ni.checkImageData(b64(PNG), 'image/svg+xml').ok, false);
  assert.strictEqual(ni.checkImageData(b64(PNG), undefined).ok, false);
  assert.strictEqual(ni.checkImageData(PNG, 'image/png').ok, false);
  assert.strictEqual(ni.checkImageData(null, 'image/png').ok, false);
});

test('empty input is rejected', () => {
  assert.strictEqual(ni.checkImageData('', 'image/png').ok, false);
  assert.strictEqual(ni.checkImageData('!!!', 'image/png').ok, false); // decodes to nothing
});

test('oversize input is rejected, the limit itself is accepted', () => {
  const at = Buffer.alloc(ni.MAX_BYTES); PNG.copy(at);
  assert.strictEqual(ni.checkImageData(b64(at), 'image/png').ok, true);
  const over = Buffer.alloc(ni.MAX_BYTES + 1); PNG.copy(over);
  const r = ni.checkImageData(b64(over), 'image/png');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /too large/);
});

test('id, ext and file-name validation', () => {
  assert.ok(ni.isValidId('lk3j2h1-0a1b2c3d4e5f'));
  for (const bad of ['short', 'A'.repeat(10), '../../etc/x', 'abc/defgh', 'abcdefgh.png', 'a'.repeat(41), '', null, 12345678])
    assert.strictEqual(ni.isValidId(bad), false, String(bad));

  for (const ext of ['png', 'jpg', 'gif', 'webp']) assert.ok(ni.isValidExt(ext));
  for (const bad of ['jpeg', 'PNG', 'svg', 'constructor', '__proto__', '', null])
    assert.strictEqual(ni.isValidExt(bad), false, String(bad));

  assert.strictEqual(ni.imageFileName({ id: 'abcdefgh-1234', ext: 'png' }), 'abcdefgh-1234.png');
  assert.strictEqual(ni.imageFileName({ id: '../abcdefgh', ext: 'png' }), null);
  assert.strictEqual(ni.imageFileName({ id: 'abcdefgh', ext: 'png/../x' }), null);
  assert.strictEqual(ni.imageFileName(null), null);
  assert.strictEqual(ni.imageFileName('abcdefgh.png'), null);

  assert.ok(ni.isImageFileName('abcdefgh-1234.webp'));
  for (const bad of ['abcdefgh.jpeg', 'abc.png', 'repo-notes.json', 'abcdefgh.png.bak', 'ABCDEFGH.png', '.abcdefgh.png'])
    assert.strictEqual(ni.isImageFileName(bad), false, bad);

  assert.strictEqual(ni.extForMediaType('image/jpeg'), 'jpg');
  assert.strictEqual(ni.extForMediaType('image/jpg'), null);
});
