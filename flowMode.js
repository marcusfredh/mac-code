// Per-session orchestrate flow mode. Pure: no I/O, no Electron — main.js writes the
// file, the global orchestrate-gate hook reads it (with its own copy of these rules,
// since it can't require from the repo).
//
// File: ~/.claude/state/orchestrate-mode/<flowKey>.json = {"mode": ..., "at": <ms>}.
// A missing, unreadable or invalid file means "full".
//   full       - the whole flow, as without a mode file
//   no-skeptic - orchestrate still required before edits, but no Skeptic reviews
//   off        - no flow at all: no reminder, no edit gate, no Stop block
const path = require('path');

const MODES = ['full', 'no-skeptic', 'off'];
// flowKey is a crypto.randomUUID() from main.js; anything else could escape the dir.
const KEY_RE = /^[\w-]{1,64}$/;

function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : 'full';
}

// Null for an invalid key, so a caller can't build a path from it by accident.
function modePath(dir, key) {
  return isValidKey(key) ? path.join(dir, `${key}.json`) : null;
}

function serialize(mode, now) {
  return JSON.stringify({ mode: normalizeMode(mode), at: now });
}

module.exports = { MODES, isValidKey, normalizeMode, modePath, serialize };
