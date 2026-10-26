const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { MODES, isValidKey, normalizeMode, modePath, serialize } = require('../flowMode');

test('MODES lists full, no-skeptic and off', () => {
  assert.deepStrictEqual(MODES, ['full', 'no-skeptic', 'off']);
});

test('isValidKey accepts uuids and word keys only', () => {
  for (const k of ['0b6c9a8e-1f2d-4c3b-9a7e-5d4c3b2a1f0e', 'abc', 'a_b-C9', 'x'.repeat(64)]) {
    assert.strictEqual(isValidKey(k), true, k);
  }
  for (const k of ['', 'x'.repeat(65), '../x', 'a/b', 'a\\b', 'a.json', 'a b', 'C:x', null, undefined, 12, {}]) {
    assert.strictEqual(isValidKey(k), false, String(k));
  }
});

test('normalizeMode maps unknown values to full', () => {
  assert.strictEqual(normalizeMode('full'), 'full');
  assert.strictEqual(normalizeMode('no-skeptic'), 'no-skeptic');
  assert.strictEqual(normalizeMode('off'), 'off');
  for (const m of ['OFF', 'none', '', null, undefined, 1, ['off'], { mode: 'off' }]) {
    assert.strictEqual(normalizeMode(m), 'full', String(m));
  }
});

test('modePath joins a valid key and refuses anything else', () => {
  const dir = path.join('home', '.claude', 'state', 'orchestrate-mode');
  assert.strictEqual(modePath(dir, 'abc-1'), path.join(dir, 'abc-1.json'));
  assert.strictEqual(modePath(dir, '../evil'), null);
  assert.strictEqual(modePath(dir, ''), null);
  assert.strictEqual(modePath(dir, undefined), null);
});

test('serialize writes the normalized mode and time', () => {
  assert.deepStrictEqual(JSON.parse(serialize('off', 123)), { mode: 'off', at: 123 });
  assert.deepStrictEqual(JSON.parse(serialize('no-skeptic', 5)), { mode: 'no-skeptic', at: 5 });
  assert.deepStrictEqual(JSON.parse(serialize('bogus', 7)), { mode: 'full', at: 7 });
});
