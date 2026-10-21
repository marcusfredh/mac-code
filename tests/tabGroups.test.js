const test = require('node:test');
const assert = require('node:assert');
const { normalizeOrder, dragOrder, pickGroupColor, sanitizeSavedGroups, collapsedAfterRestore } = require('../tabGroups');

const items = (spec) => spec.split(' ').map((s) => {
  const [id, groupId] = s.split(':');
  return { id, groupId: groupId || null };
});

test('normalizeOrder puts each header before its first member', () => {
  assert.deepStrictEqual(normalizeOrder(items('a b:g1 c:g1 d')), ['a', 'g1', 'b', 'c', 'd']);
  assert.deepStrictEqual(normalizeOrder(items('a:g1')), ['g1', 'a']);
  assert.deepStrictEqual(normalizeOrder([]), []);
});

test('normalizeOrder gathers scattered members at the first member, keeping their order', () => {
  assert.deepStrictEqual(normalizeOrder(items('b:g1 x c:g1 y a:g1')), ['g1', 'b', 'c', 'a', 'x', 'y']);
  assert.deepStrictEqual(normalizeOrder(items('x a:g1 b:g2 c:g1 d:g2')), ['x', 'g1', 'a', 'c', 'g2', 'b', 'd']);
});

test('normalizeOrder: a tab removed from the middle of its group lands after the group', () => {
  assert.deepStrictEqual(normalizeOrder(items('a:g1 x b:g1')), ['g1', 'a', 'b', 'x']);
});

test('normalizeOrder leaves groups with no members out', () => {
  const out = normalizeOrder(items('a b'));
  assert.ok(!out.includes('g1'));
});

// Strip helper: every element 100px wide, headers 40px, hidden members 0px.
function strip(spec, collapsed = new Set()) {
  let x = 0;
  return spec.split(' ').map((s) => {
    if (s.startsWith('#')) {
      const groupId = s.slice(1);
      const e = { key: groupId, kind: 'header', groupId, left: x, right: x + 40, hidden: false };
      x += 40;
      return e;
    }
    const [key, groupId] = s.split(':');
    const hidden = !!groupId && collapsed.has(groupId);
    const w = hidden ? 0 : 100;
    const e = { key, kind: 'tab', groupId: groupId || null, left: x, right: x + w, hidden };
    x += w;
    return e;
  });
}

test('dragOrder: plain tabs reorder by sibling midpoint', () => {
  const s = strip('a b c');              // a 0-100, b 100-200, c 200-300
  assert.deepStrictEqual(dragOrder(s, { key: 'a', kind: 'tab', groupId: null }, 160), ['b', 'a', 'c']);
  assert.strictEqual(dragOrder(s, { key: 'a', kind: 'tab', groupId: null }, 120), null);   // before b: no change
  assert.strictEqual(dragOrder(s, { key: 'a', kind: 'tab', groupId: null }, 500), null);   // off the strip
});

test('dragOrder: an ungrouped tab hops over a group block as one unit', () => {
  // a 0-100, #g 100-140, b 140-240, c 240-340, d 340-440. Block g spans 100-340, mid 220.
  const s = strip('a #g b:g c:g d');
  const drag = { key: 'a', kind: 'tab', groupId: null };
  assert.strictEqual(dragOrder(s, drag, 200), null);                                    // first half: stays before
  assert.deepStrictEqual(dragOrder(s, drag, 260), ['g', 'b', 'c', 'a', 'd']);           // second half: after the block
  // Over the header itself counts as the block too, and never lands between members.
  const d = { key: 'd', kind: 'tab', groupId: null };
  assert.deepStrictEqual(dragOrder(s, d, 110), ['a', 'd', 'g', 'b', 'c']);
  assert.deepStrictEqual(dragOrder(s, d, 160), ['a', 'd', 'g', 'b', 'c']);
});

test('dragOrder: a collapsed group is just its header', () => {
  // a 0-100, #g 100-140, b,c hidden, d 140-240
  const s = strip('a #g b:g c:g d', new Set(['g']));
  const d = { key: 'd', kind: 'tab', groupId: null };
  assert.deepStrictEqual(dragOrder(s, d, 110), ['a', 'd', 'g', 'b', 'c']);
  const a = { key: 'a', kind: 'tab', groupId: null };
  assert.deepStrictEqual(dragOrder(s, a, 130), ['g', 'b', 'c', 'a', 'd']);              // after the collapsed group
  // Tab before a group at the very start of the strip.
  const s2 = strip('#g b:g c:g d', new Set(['g']));
  assert.deepStrictEqual(dragOrder(s2, d, 10), ['d', 'g', 'b', 'c']);
});

test('dragOrder: a member stays inside its own group span', () => {
  // x 0-100, #g 100-140, a 140-240, b 240-340, c 340-440, y 440-540
  const s = strip('x #g a:g b:g c:g y');
  const a = { key: 'a', kind: 'tab', groupId: 'g' };
  assert.deepStrictEqual(dragOrder(s, a, 300), ['x', 'g', 'b', 'a', 'c', 'y']);
  assert.deepStrictEqual(dragOrder(s, a, 420), ['x', 'g', 'b', 'c', 'a', 'y']);
  assert.strictEqual(dragOrder(s, a, 500), null);                                       // over y: can't leave
  assert.strictEqual(dragOrder(s, a, 50), null);                                        // over x
  assert.strictEqual(dragOrder(s, a, 120), null);                                       // over its header
  const c = { key: 'c', kind: 'tab', groupId: 'g' };
  assert.deepStrictEqual(dragOrder(s, c, 150), ['x', 'g', 'c', 'a', 'b', 'y']);
});

test('dragOrder: a lone member has nowhere to go', () => {
  assert.strictEqual(dragOrder(strip('x #g a:g y'), { key: 'a', kind: 'tab', groupId: 'g' }, 50), null);
});

test('dragOrder: a header carries its whole block, hidden members included', () => {
  // #g 0-40, a,b hidden, x 40-140, #h 140-180, c 180-280 (block h 140-280, mid 210)
  const s = strip('#g a:g b:g x #h c:h', new Set(['g']));
  const g = { key: 'g', kind: 'header', groupId: 'g' };
  assert.deepStrictEqual(dragOrder(s, g, 100), ['x', 'g', 'a', 'b', 'h', 'c']);
  assert.deepStrictEqual(dragOrder(s, g, 200), ['x', 'g', 'a', 'b', 'h', 'c']);      // first half of h: before it
  assert.strictEqual(dragOrder(s, g, 60), null);                                        // first half of x: stays
  assert.deepStrictEqual(dragOrder(s, g, 250), ['x', 'h', 'c', 'g', 'a', 'b']);
  // Expanded block dragged left over a plain tab.
  const s2 = strip('x #h c:h d:h');
  assert.deepStrictEqual(dragOrder(s2, { key: 'h', kind: 'header', groupId: 'h' }, 20), ['h', 'c', 'd', 'x']);
});

test('pickGroupColor prefers an unused colour, then cycles', () => {
  const pal = ['r', 'g', 'b'];
  assert.strictEqual(pickGroupColor(pal, new Set(), 0), 'r');
  assert.strictEqual(pickGroupColor(pal, new Set(['r']), 1), 'g');
  assert.strictEqual(pickGroupColor(pal, new Set(['r', 'g', 'b']), 3), 'r');
  assert.strictEqual(pickGroupColor(pal, new Set(['r', 'g', 'b']), 4), 'g');
  assert.strictEqual(pickGroupColor([], new Set(), 0), null);
});

test('sanitizeSavedGroups drops junk and keeps the first of a duplicate id', () => {
  const pal = ['#f44747', '#3b78ff'];
  const out = sanitizeSavedGroups([
    null, 'x', { groupId: 7 }, { groupId: '' },
    { groupId: 'grp-1', name: '  Backend  ', color: '#3b78ff', collapsed: true },
    { groupId: 'grp-1', name: 'dup' },
    { groupId: 'grp-2', name: 'x'.repeat(80), color: 'url(evil)', collapsed: 'yes' }
  ], pal);
  assert.deepStrictEqual(out, [
    { groupId: 'grp-1', name: 'Backend', color: '#3b78ff', collapsed: true },
    { groupId: 'grp-2', name: 'x'.repeat(60), color: null, collapsed: false }
  ]);
  assert.deepStrictEqual(sanitizeSavedGroups(undefined, pal), []);
});

test('collapsedAfterRestore keeps the saved flags, except for the active tab group', () => {
  const restored = [{ groupId: 'grp-1', collapsed: true }, { groupId: 'grp-2', collapsed: false }, { groupId: 'grp-3', collapsed: true }];
  // A | [G: B C] with G collapsed and A (ungrouped) active: G stays collapsed.
  assert.deepStrictEqual(collapsedAfterRestore(restored, null), ['grp-1', 'grp-3']);
  // The active tab sits in a group saved collapsed: that one opens.
  assert.deepStrictEqual(collapsedAfterRestore(restored, 'grp-3'), ['grp-1']);
  assert.deepStrictEqual(collapsedAfterRestore(restored, 'grp-2'), ['grp-1', 'grp-3']);
  assert.deepStrictEqual(collapsedAfterRestore([], 'grp-1'), []);
});
