const test = require('node:test');
const assert = require('node:assert');
const { MAX_ITEMS, normalize, recordUse, removeUse, topUses } = require('../repoUsage');

const empty = () => normalize(null);

test('normalize: garbage becomes an empty state', () => {
  for (const g of [null, undefined, 5, 'x', [], {}, { items: 3 }, { items: null }]) {
    const s = normalize(g);
    assert.strictEqual(s.v, 1);
    assert.strictEqual(Object.keys(s.items).length, 0);
  }
});

test('normalize: drops bad entries, keeps good ones, sanitises repo', () => {
  const s = normalize({ items: {
    a: { path: 'C:\\dev\\A', repo: 'o/a', count: 3, last: 10 },
    b: { path: '', count: 2, last: 1 },
    c: { path: 'C:\\dev\\C', count: 0, last: 1 },
    d: { path: 'C:\\dev\\D', count: 'x', last: 1 },
    e: { path: 'C:\\dev\\E', repo: 'not a repo', count: 2.9, last: 'z' },
    f: null
  } });
  assert.deepStrictEqual(Object.keys(s.items).sort(), ['c:\\dev\\a', 'c:\\dev\\e']);
  assert.strictEqual(s.items['c:\\dev\\a'].count, 3);
  assert.strictEqual(s.items['c:\\dev\\e'].repo, null);
  assert.strictEqual(s.items['c:\\dev\\e'].count, 2);
  assert.strictEqual(s.items['c:\\dev\\e'].last, 0);
});

test('normalize: a __proto__ key is just data', () => {
  const s = normalize(JSON.parse('{"items":{"__proto__":{"path":"C:\\\\x","count":1,"last":1}}}'));
  assert.strictEqual(Object.keys(s.items).length, 1);
  assert.strictEqual(({}).path, undefined);
});

test('recordUse: counts case-insensitively, keeps first spelling, updates last', () => {
  let s = recordUse(empty(), { path: 'C:\\dev\\Mac-Code', repo: 'me/mac-code' }, 100);
  s = recordUse(s, { path: 'c:\\dev\\mac-code', repo: null }, 200);
  const list = topUses(s);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].path, 'C:\\dev\\Mac-Code');
  assert.strictEqual(list[0].repo, 'me/mac-code');
  assert.strictEqual(list[0].count, 2);
  assert.strictEqual(list[0].last, 200);
});

test('recordUse: ignores a missing path and does not mutate its input', () => {
  const s0 = recordUse(empty(), { path: 'C:\\a' }, 1);
  const snap = JSON.stringify(s0);
  assert.strictEqual(Object.keys(recordUse(s0, { path: '' }, 2).items).length, 1);
  assert.strictEqual(Object.keys(recordUse(s0, null, 2).items).length, 1);
  recordUse(s0, { path: 'C:\\b' }, 3);
  assert.strictEqual(JSON.stringify(s0), snap);
});

test('topUses: count desc, ties by last desc, limit applies', () => {
  let s = empty();
  s = recordUse(s, { path: 'C:\\a' }, 1);
  s = recordUse(s, { path: 'C:\\b' }, 2);
  s = recordUse(s, { path: 'C:\\b' }, 3);
  s = recordUse(s, { path: 'C:\\c' }, 4);
  assert.deepStrictEqual(topUses(s).map((i) => i.path), ['C:\\b', 'C:\\c', 'C:\\a']);
  assert.deepStrictEqual(topUses(s, { limit: 2 }).map((i) => i.path), ['C:\\b', 'C:\\c']);
});

test('topUses: filter matches name, repo and path', () => {
  let s = empty();
  s = recordUse(s, { path: 'C:\\dev\\alpha', repo: 'acme/widgets' }, 1);
  s = recordUse(s, { path: 'D:\\work\\beta' }, 2);
  assert.deepStrictEqual(topUses(s, { filter: 'ALP' }).map((i) => i.path), ['C:\\dev\\alpha']);
  assert.deepStrictEqual(topUses(s, { filter: 'widgets' }).map((i) => i.path), ['C:\\dev\\alpha']);
  assert.deepStrictEqual(topUses(s, { filter: 'd:\\work' }).map((i) => i.path), ['D:\\work\\beta']);
  assert.deepStrictEqual(topUses(s, { filter: 'nope' }), []);
});

test('removeUse: removes one entry, case-insensitively', () => {
  let s = recordUse(recordUse(empty(), { path: 'C:\\A' }, 1), { path: 'C:\\B' }, 2);
  s = removeUse(s, 'c:\\a');
  assert.deepStrictEqual(topUses(s).map((i) => i.path), ['C:\\B']);
  assert.strictEqual(topUses(removeUse(s, 'C:\\none')).length, 1);
});

test('cap: past the limit the lowest count (then oldest) is dropped', () => {
  let s = empty();
  for (let i = 0; i < MAX_ITEMS; i++) s = recordUse(s, { path: 'C:\\r' + i }, 1000 + i);
  s = recordUse(s, { path: 'C:\\r5' }, 5000);            // count 2
  s = recordUse(s, { path: 'C:\\new' }, 6000);           // count 1, newest
  const paths = topUses(s, { limit: Infinity }).map((i) => i.path);
  assert.strictEqual(paths.length, MAX_ITEMS);
  assert.ok(paths.includes('C:\\r5'));
  assert.ok(paths.includes('C:\\new'));
  assert.ok(!paths.includes('C:\\r0'));                  // oldest of the count-1 entries
});
