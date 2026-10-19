const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const en = require('../errorNotes');

const HOME = 'C:\\Users\\marcus';
const mkErr = (msg, frame) => {
  const e = new Error(msg);
  e.stack = 'Error: ' + msg + '\n' + (frame || '    at doIt (C:\\Users\\marcus\\dev\\app\\main.js:10:5)') +
    '\n    at a (C:\\Users\\marcus\\x.js:1:1)\n    at b (x.js:2:2)\n    at c (x.js:3:3)\n    at d (x.js:4:4)\n    at e (x.js:5:5)\n    at f (x.js:6:6)';
  return e;
};
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const rec = (over) => en.formatError(Object.assign({ source: 'main', error: mkErr('boom 42'), version: '0.19.0', home: HOME, now: NOW }, over));
const ids = () => { let n = 0; return () => 'id' + (++n); };
const opts = (now, extra) => Object.assign({ now, newId: ids() }, extra);
const autos = (d) => d.repos[en.REPO_KEY].items.filter((i) => i.auto === 'error');
// Distinct, digit-free messages (digits are normalised away in fingerprints).
const uniq = (i) => 'u-' + i.toString(26).split('').map((c) => String.fromCharCode(c.charCodeAt(0) < 58 ? c.charCodeAt(0) + 49 : c.charCodeAt(0) + 10)).join('');

test('formatError: header, 5 stack lines, version and ISO time; home shortened to ~', () => {
  const r = rec();
  const lines = r.text.split('\n');
  assert.strictEqual(lines[0], '⚠ Mac Code-fel (main): Error: boom 42');
  assert.strictEqual(lines.length, 1 + 5 + 1);
  assert.strictEqual(lines[1], 'at doIt (~\\dev\\app\\main.js:10:5)');
  assert.strictEqual(lines[lines.length - 1], 'v0.19.0 · 2026-01-02T03:04:05.000Z');
  assert.ok(!r.text.includes('marcus'));
  assert.ok(!r.stack.includes('C:\\Users\\marcus'));
  assert.strictEqual(r.at, NOW);
});

test('formatError: forward-slash and file:// paths, and unknown home, are shortened too', () => {
  assert.strictEqual(en.shortenPaths('file:///c:/users/Marcus/dev/a.js', HOME), 'file:///~/dev/a.js');
  assert.strictEqual(en.shortenPaths('C:/Users/someone/dev/a.js', null), '~/dev/a.js');
});

test('formatError: non-Error reasons (string, object) and missing version', () => {
  const s = en.formatError({ source: 'main (promise)', reason: 'plain text', now: NOW });
  assert.strictEqual(s.text.split('\n')[0], '⚠ Mac Code-fel (main (promise)): Error: plain text');
  assert.ok(!/^v/.test(s.text.split('\n').pop()));
  const o = en.formatError({ source: 'x', error: { name: 'RenderProcessGone', message: 'reason=crashed' }, now: NOW });
  assert.strictEqual(o.name, 'RenderProcessGone');
});

test('formatError: whole text capped at 1500 chars, message at 600', () => {
  const r = rec({ error: mkErr('x'.repeat(5000)) });
  assert.ok(r.text.length <= en.TEXT_CAP);
  assert.ok(r.text.split('\n')[0].length < 700);
  const long = rec({ error: mkErr('m', '    at ' + 'y'.repeat(2000) + ' (f.js:1:1)') });
  assert.ok(long.text.length <= en.TEXT_CAP);
  assert.ok(long.text.endsWith('2026-01-02T03:04:05.000Z'));
});

test('formatError: full stack kept for errors.log but capped at 64 KB', () => {
  const e = new Error('big');
  e.stack = 'Error: big\n' + 'at z (f.js:1:1)\n'.repeat(20000);
  assert.ok(rec({ error: e }).stack.length <= 64 * 1024);
});

test('fingerprint: stable across numbers and line numbers, differs by source/name/message/frame', () => {
  const a = rec({ error: mkErr('port 3000 busy after 12ms') });
  const b = rec({ error: mkErr('port 4001 busy after 99ms', '    at doIt (C:\\Users\\marcus\\dev\\app\\main.js:77:9)') });
  assert.strictEqual(a.fingerprint, b.fingerprint);
  assert.notStrictEqual(a.fingerprint, rec({ source: 'renderer', error: mkErr('port 3000 busy after 12ms') }).fingerprint);
  assert.notStrictEqual(a.fingerprint, rec({ error: mkErr('other thing') }).fingerprint);
  assert.notStrictEqual(a.fingerprint, rec({ error: mkErr('port 3000 busy after 12ms', '    at elsewhere (main.js:1:1)') }).fingerprint);
  const t = new TypeError('port 1 busy');
  t.stack = mkErr('port 1 busy').stack.replace('Error:', 'TypeError:');
  assert.notStrictEqual(a.fingerprint, rec({ error: t }).fingerprint);
});

test('shouldIgnore: ResizeObserver, bare ErrorEvents, Script error, foreign origins; real errors kept', () => {
  assert.ok(en.shouldIgnore({ message: 'ResizeObserver loop completed with undelivered notifications.' }));
  assert.ok(en.shouldIgnore({ message: 'ResizeObserver loop limit exceeded' }));
  assert.ok(en.shouldIgnore({ message: 'x', hasError: false, filename: '', stack: '' }));
  assert.ok(en.shouldIgnore({ message: 'Script error.', stack: '' }));
  assert.ok(en.shouldIgnore({ message: 'x', filename: 'chrome-extension://abc/content.js', hasError: true }));
  assert.ok(en.shouldIgnore({ message: 'x', stack: 'Error: x\n at f (devtools://devtools/bundled/a.js:1:1)' }));
  assert.ok(!en.shouldIgnore({ message: 'x', filename: 'file:///C:/app/renderer.js', stack: 'at f (file:///C:/app/renderer.js:1:1)', hasError: true }));
  assert.ok(!en.shouldIgnore({ message: 'string rejection', hasError: true, filename: '', stack: '' }));
  assert.ok(!en.shouldIgnore(rec()));
});

test('addErrorToNotes: creates the repo entry and a new auto item at the top', () => {
  const data = { version: 1, repos: {} };
  const r = rec();
  const res = en.addErrorToNotes(data, r, opts(NOW));
  assert.ok(res.added && res.changed);
  const repo = data.repos['gh:marcusfredh/mac-code'];
  assert.strictEqual(repo.name, 'marcusfredh/Mac-Code');
  assert.deepStrictEqual(repo.stages, ['dev', 'prod']);
  const it = repo.items[0];
  assert.strictEqual(it.text, r.text);
  assert.strictEqual(it.auto, 'error');
  assert.strictEqual(it.fingerprint, r.fingerprint);
  assert.strictEqual(it.count, 1);
  assert.strictEqual(it.done, false);
  assert.strictEqual(it.id, 'id1');
});

test('addErrorToNotes: tolerates null data and bad records', () => {
  assert.strictEqual(en.addErrorToNotes(null, rec(), opts(NOW)).data.repos[en.REPO_KEY].items.length, 1);
  assert.strictEqual(en.addErrorToNotes({ repos: {} }, { text: 'x' }, opts(NOW)).added, false);
  assert.strictEqual(en.addErrorToNotes({ repos: {} }, null, opts(NOW)).added, false);
});

test('dedupe: same fingerprint bumps count/lastSeen, never rewrites text; throttled within 60 s', () => {
  const data = { version: 1, repos: {} };
  const r = rec();
  en.addErrorToNotes(data, r, opts(NOW));
  const it = autos(data)[0];
  let res = en.addErrorToNotes(data, r, opts(NOW + 30000));
  assert.deepStrictEqual([res.added, res.changed], [false, false]);
  res = en.addErrorToNotes(data, r, opts(NOW + 59000));
  assert.strictEqual(it.count, 1);
  assert.strictEqual(it.pending, 2);
  // past 60 s the accumulated ones land too: 1 + 2 pending + this one
  res = en.addErrorToNotes(data, r, opts(NOW + 61000));
  assert.ok(res.changed && !res.added);
  assert.strictEqual(it.count, 4);
  assert.strictEqual(it.pending, 0);
  assert.strictEqual(it.lastSeen, NOW + 61000);
  assert.strictEqual(it.updated, NOW + 61000);
  assert.strictEqual(it.text, r.text);
  assert.strictEqual(autos(data).length, 1);
});

test('dedupe: a bump reopens a done item only after >= 10 minutes since the last bump', () => {
  const data = { version: 1, repos: {} };
  const r = rec();
  const MIN = 60000;
  en.addErrorToNotes(data, r, opts(NOW));
  const it = autos(data)[0];
  it.done = true;
  en.addErrorToNotes(data, r, opts(NOW + 5 * MIN));              // 5 min: counted, stays done
  assert.strictEqual(it.count, 2);
  assert.strictEqual(it.done, true);
  en.addErrorToNotes(data, r, opts(NOW + 14 * MIN));             // 9 min after the last bump
  assert.strictEqual(it.done, true);
  en.addErrorToNotes(data, r, opts(NOW + 24 * MIN));             // 10 min after the last bump
  assert.strictEqual(it.done, false);
  assert.strictEqual(it.count, 4);
});

test('caps: at most 30 open auto items, oldest open one dropped', () => {
  const data = { version: 1, repos: {} };
  for (let i = 0; i < 35; i++) en.addErrorToNotes(data, rec({ error: mkErr(uniq(i)) }), opts(NOW + i * 1000));
  const list = autos(data);
  assert.strictEqual(list.length, 30);
  assert.strictEqual(list[0].created, NOW + 34 * 1000);
  assert.strictEqual(list[list.length - 1].created, NOW + 5 * 1000);
});

test('caps: at most 50 auto items in total, done ones go first', () => {
  const data = { version: 1, repos: {} };
  for (let i = 0; i < 70; i++) {
    en.addErrorToNotes(data, rec({ error: mkErr(uniq(i)) }), opts(NOW + i));
    if (i >= 5) autos(data)[0].done = true;       // the newest is first; the first five stay open
  }
  const list = autos(data);
  assert.strictEqual(list.length, 50);
  assert.strictEqual(list.filter((i) => !i.done).length, 5);
});

test('session storm guard: at most 20 new items per session, bumps still go through', () => {
  const data = { version: 1, repos: {} };
  const session = { added: 0 };
  for (let i = 0; i < 25; i++) en.addErrorToNotes(data, rec({ error: mkErr(uniq(i)) }), opts(NOW + i, { session }));
  assert.strictEqual(autos(data).length, 20);
  const oldest = autos(data)[autos(data).length - 1];
  const res = en.addErrorToNotes(data, rec({ error: mkErr(uniq(0)) }), opts(NOW + 120000, { session }));
  assert.ok(res.changed);
  assert.strictEqual(oldest.count, 2);
});

test('non-auto items are never touched, deduped against or dropped', () => {
  const manual = [];
  for (let i = 0; i < 60; i++) manual.push({ id: 'm' + i, text: 'todo ' + i, branch: null, done: i % 2 === 0, stages: {}, created: i, updated: i });
  const lookalike = { id: 'x', text: 'copy', done: false, fingerprint: rec().fingerprint, count: 7 }; // no auto flag
  const all = manual.concat([lookalike]);
  const before = JSON.stringify(all);
  const data = { version: 1, repos: {
    [en.REPO_KEY]: { name: 'n', scratch: 's', stages: ['dev'], items: all },
    'gh:other/repo': { name: 'o', scratch: '', stages: ['dev', 'prod'], items: [] }
  } };
  en.addErrorToNotes(data, rec(), opts(NOW));       // same fingerprint as the look-alike: still a new item
  for (let i = 0; i < 40; i++) en.addErrorToNotes(data, rec({ error: mkErr(uniq(i)) }), opts(NOW + 1 + i));
  const items = data.repos[en.REPO_KEY].items;
  assert.strictEqual(JSON.stringify(items.filter((i) => !i.auto)), before);
  assert.strictEqual(lookalike.count, 7);
  assert.strictEqual(data.repos[en.REPO_KEY].scratch, 's');
  assert.deepStrictEqual(data.repos[en.REPO_KEY].stages, ['dev']);
  assert.deepStrictEqual(data.repos['gh:other/repo'].items, []);
});

// ---- renderer side: notesView.js with a stubbed window ----
function loadNotesView(win) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'notesView.js'), 'utf8'),
    { window: win, Promise, Date, Math, setTimeout, clearTimeout });
  return win.repoNotes;
}
function stubWindow({ file, exists, pending }) {
  const saved = [];
  const win = {
    addEventListener() {}, errorNotes: en, __macErrorQueue: [],
    notesApi: { load: async () => file, save: (d) => saved.push(JSON.parse(JSON.stringify(d))), status: async () => ({ exists }) },
    settingsApi: { version: async () => '9.9.9' },
    errorsApi: { onNote(cb) { win.live = cb; }, takePending: async () => { win.taken = true; return pending || []; }, log() {} }
  };
  return { win, saved };
}
const settle = () => new Promise((r) => setTimeout(r, 500));
const rendererRec = (message) => ({ source: 'renderer', name: 'TypeError', message,
  stack: 'TypeError: ' + message + '\n at f (file:///C:/app/r.js:1:1)', filename: 'file:///C:/app/r.js', hasError: true });

test('notesView: queued errors are filed after load, formatted with the version, then saved', async () => {
  const { win, saved } = stubWindow({ file: { version: 1, repos: {} }, exists: true, pending: [rec({ error: mkErr('from main') })] });
  win.__macErrorQueue.push(rendererRec('early'),
    { source: 'renderer', name: 'Error', message: 'ResizeObserver loop limit exceeded', hasError: true, filename: 'file:///x.js' });
  const rn = loadNotesView(win);
  await rn.errorsReady;
  await settle();
  assert.ok(win.taken);
  assert.strictEqual(typeof win.__macErrorSink, 'function');
  assert.strictEqual(typeof win.live, 'function');
  const items = saved[saved.length - 1].repos[en.REPO_KEY].items;
  assert.strictEqual(items.length, 2);
  assert.ok(items.some((i) => /renderer\): TypeError: early/.test(i.text) && /v9\.9\.9 · /.test(i.text)));
  win.__macErrorSink(rendererRec('late'));
  await settle();
  assert.strictEqual(saved[saved.length - 1].repos[en.REPO_KEY].items.length, 3);
});

test('notesView: unreadable notes file (load null, file exists) is never saved over', async () => {
  const { win, saved } = stubWindow({ file: null, exists: true });
  win.__macErrorQueue.push(rendererRec('x'));
  const rn = loadNotesView(win);
  await rn.errorsReady;
  rn.addErrorNote(rendererRec('y'));
  await settle();
  assert.strictEqual(saved.length, 0);
  assert.ok(!win.taken, 'pending stays in main when the notes could not be loaded');
});

test('notesView: a missing notes file is fine - the repo entry is created and saved', async () => {
  const { win, saved } = stubWindow({ file: null, exists: false });
  const rn = loadNotesView(win);
  await rn.errorsReady;
  rn.addErrorNote(rec());
  await settle();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].repos[en.REPO_KEY].items.length, 1);
});
