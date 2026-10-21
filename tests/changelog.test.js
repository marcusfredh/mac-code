const test = require('node:test');
const assert = require('node:assert');
const CHANGELOG = require('../changelog');
const pkg = require('../package.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v) => SEMVER.exec(v).slice(1).map(Number);
const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

test('package.json version has a changelog entry', () => {
  assert.ok(CHANGELOG.some((e) => e.version === pkg.version), `add an entry for ${pkg.version} to changelog.js`);
});

test('versions are unique, x.y.z and sorted descending', () => {
  const seen = new Set();
  CHANGELOG.forEach((e, i) => {
    assert.match(e.version, SEMVER);
    assert.ok(!seen.has(e.version), 'duplicate ' + e.version);
    seen.add(e.version);
    if (i > 0) assert.ok(cmp(CHANGELOG[i - 1].version, e.version) > 0, `${e.version} must come after ${CHANGELOG[i - 1].version}`);
  });
});

test('dates are ISO and never increase going down the list', () => {
  CHANGELOG.forEach((e, i) => {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(e.date)), 'invalid date ' + e.date);
    assert.strictEqual(new Date(e.date + 'T00:00:00Z').toISOString().slice(0, 10), e.date);
    if (i > 0) assert.ok(CHANGELOG[i - 1].date >= e.date, `${e.version} is dated after ${CHANGELOG[i - 1].version}`);
  });
});

test('every entry has at least one non-empty string item', () => {
  for (const e of CHANGELOG) {
    assert.ok(Array.isArray(e.items) && e.items.length > 0, e.version + ' has no items');
    for (const t of e.items) assert.ok(typeof t === 'string' && t.trim() !== '', e.version + ' has an empty item');
  }
});
