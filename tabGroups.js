// Tab groups: the ordering rules behind the tab strip's group headers. Pure (no DOM, no
// storage) so it can be unit-tested; renderer.js feeds it the strip as plain records and
// applies the key order it hands back.
//
// The strip is flat: a group's header chip sits directly before its first member, and
// the members follow it contiguously. Keys are tab ids ('tab-N') and group ids
// ('grp-N'); the two never collide.
(() => {
  'use strict';

  // items: [{ id, groupId }] in strip order (tabs only, headers left out); groupId null
  // for an ungrouped tab. Returns the normalized key order, headers included: each
  // group's members gathered, in their current relative order, at the position of its
  // first member, its header directly before them. A group with no members has no key.
  function normalizeOrder(items) {
    const members = new Map();   // groupId -> [tab id]
    for (const it of items) {
      if (!it.groupId) continue;
      if (!members.has(it.groupId)) members.set(it.groupId, []);
      members.get(it.groupId).push(it.id);
    }
    const out = [];
    const emitted = new Set();
    for (const it of items) {
      if (!it.groupId) { out.push(it.id); continue; }
      if (emitted.has(it.groupId)) continue;
      emitted.add(it.groupId);
      out.push(it.groupId, ...members.get(it.groupId));
    }
    return out;
  }

  // Where a strip drag lands. entries: every strip element in order, as
  //   { key, kind: 'tab' | 'header', groupId, left, right, hidden }
  // (a header's groupId is its own group; hidden = a collapsed group's member, which has
  // no box). drag: { key, kind, groupId } for the element under the pointer. Returns
  // the new key order, or null when x hits nothing that would move it.
  //  - a member tab only moves within its own group's span; it can't leave by drag
  //  - an ungrouped tab hops over group blocks as units: a header plus its visible
  //    members is one target, before or after it by the block's midpoint
  //  - a header carries its whole block (hidden members too), landing on the same units
  function dragOrder(entries, drag, x) {
    const block = drag.kind === 'header'
      ? entries.filter(e => e.groupId === drag.groupId)
      : entries.filter(e => e.key === drag.key);
    const blockKeys = new Set(block.map(e => e.key));
    const rest = entries.filter(e => !blockKeys.has(e.key));

    // Targets: [{ first, last, left, right }] by key, in strip order.
    const units = [];
    if (drag.kind === 'tab' && drag.groupId) {
      for (const e of rest) {
        if (e.kind === 'tab' && e.groupId === drag.groupId && !e.hidden) {
          units.push({ first: e.key, last: e.key, left: e.left, right: e.right });
        }
      }
    } else {
      const byGroup = new Map();
      for (const e of rest) {
        if (e.kind === 'header') {
          const u = { first: e.key, last: e.key, left: e.left, right: e.right };
          byGroup.set(e.groupId, u);
          units.push(u);
        } else if (e.groupId && byGroup.has(e.groupId)) {
          const u = byGroup.get(e.groupId);
          u.last = e.key;
          if (!e.hidden) { u.left = Math.min(u.left, e.left); u.right = Math.max(u.right, e.right); }
        } else if (!e.groupId) {
          units.push({ first: e.key, last: e.key, left: e.left, right: e.right });
        }
      }
    }

    const hit = units.find(u => x >= u.left && x <= u.right);
    if (!hit) return null;
    const before = x < hit.left + (hit.right - hit.left) / 2;
    const keys = rest.map(e => e.key);
    const at = before ? keys.indexOf(hit.first) : keys.indexOf(hit.last) + 1;
    keys.splice(at, 0, ...block.map(e => e.key));
    const old = entries.map(e => e.key);
    return keys.every((k, i) => k === old[i]) ? null : keys;
  }

  // A new group's colour: the first palette colour no other group uses, else the palette
  // cycled by how many groups there are.
  function pickGroupColor(palette, used, groupCount) {
    const free = palette.find(c => !used.has(c));
    return free || palette[groupCount % palette.length] || null;
  }

  // Saved groups as they come back from the session file, cleaned up: only entries with
  // a string id (first one wins), a name of at most 60 characters, a colour from the
  // palette (else null, so the caller picks one) and a boolean collapsed.
  function sanitizeSavedGroups(list, palette) {
    const out = [];
    const seen = new Set();
    for (const g of Array.isArray(list) ? list : []) {
      if (!g || typeof g !== 'object' || typeof g.groupId !== 'string' || !g.groupId || seen.has(g.groupId)) continue;
      seen.add(g.groupId);
      out.push({
        groupId: g.groupId,
        name: typeof g.name === 'string' ? g.name.trim().slice(0, 60) : '',
        color: palette.includes(g.color) ? g.color : null,
        collapsed: g.collapsed === true
      });
    }
    return out;
  }

  // After a restore: which groups end up collapsed. restored: [{ groupId, collapsed }]
  // with the saved flags (new ids); every group saved collapsed stays so, except the one
  // holding the active tab, which is always expanded.
  function collapsedAfterRestore(restored, activeGroupId) {
    return restored.filter(g => g.collapsed && g.groupId !== activeGroupId).map(g => g.groupId);
  }

  const api = { normalizeOrder, dragOrder, pickGroupColor, sanitizeSavedGroups, collapsedAfterRestore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.tabGroups = api;
})();
