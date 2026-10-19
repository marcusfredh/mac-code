const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { APP_THEMES, themeById } = require('../appThemes');
const { SCHEMA } = require('../settings');

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0?\.\d+\)$/;
const def = APP_THEMES[0];

test('7 themes, ids match the settings enum, default first', () => {
  assert.strictEqual(APP_THEMES.length, 7);
  assert.deepStrictEqual(APP_THEMES.map((t) => t.id), SCHEMA.general.appTheme.values);
  assert.strictEqual(def.id, SCHEMA.general.appTheme.def);
});

test('every theme has the same var keys as default', () => {
  const keys = Object.keys(def.vars).sort();
  for (const t of APP_THEMES) assert.deepStrictEqual(Object.keys(t.vars).sort(), keys, t.id);
});

test('colors are valid (hex or rgba), radius-k is a positive number, icon is an svg', () => {
  for (const t of APP_THEMES) {
    for (const [k, v] of Object.entries(t.vars)) {
      if (k === '--radius-k') { assert.ok(Number(v) > 0, t.id + k); continue; }
      assert.ok(HEX.test(v) || RGBA.test(v), t.id + ' ' + k + ' ' + v);
    }
    for (const [k, v] of Object.entries(t.term)) assert.ok(HEX.test(v), t.id + ' term.' + k);
    for (const [k, v] of Object.entries(t.monaco.colors)) assert.ok(HEX.test(v), t.id + ' monaco ' + k);
    assert.strictEqual(t.vars['--term-bg'], t.term.background);
    assert.ok(/^<svg viewBox="0 0 16 16"/.test(t.icon) && t.icon.includes('currentColor'), t.id);
  }
});

test('default theme is today: tokens and Windows Terminal scheme', () => {
  assert.strictEqual(def.vars['--bg'], '#0c0c0c');
  assert.strictEqual(def.vars['--accent'], '#60cdff');
  assert.strictEqual(def.vars['--radius-k'], '1');
  assert.strictEqual(def.radiusK, 1);
  // every default var equals the :root declaration in renderer.html
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer.html'), 'utf8');
  const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
  for (const [k, v] of Object.entries(def.vars)) {
    const m = root.match(new RegExp('^\\s*' + k + ': ([^;]+);', 'm'));
    assert.ok(m, 'renderer.html :root has ' + k);
    assert.strictEqual(m[1], v, k);
  }
  // the terminal palette equals WINDOWS_TERMINAL_THEME in renderer.js
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const body = js.match(/const WINDOWS_TERMINAL_THEME = (\{[\s\S]*?\n\});/)[1];
  const wt = new Function('return ' + body)();
  assert.deepStrictEqual(def.term, wt);
});

test("themeById: unknown or missing id returns default", () => {
  assert.strictEqual(themeById('nope'), def);
  assert.strictEqual(themeById(undefined), def);
  assert.strictEqual(themeById('fjord').id, 'fjord');
});
