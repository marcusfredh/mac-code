const test = require('node:test');
const assert = require('node:assert');
const {
  filetimeToMs, parseSessionFile, filterCandidates, parseProcessSnapshot, pickByAncestry, lastTurnEnd
} = require('../claudeSessions');

const T0 = 1_791_901_428_950;
const toFiletime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const SID_A = 'b5a3c0de-1111-4222-8333-444455556666';
const SID_B = 'c6b4d1ef-1111-4222-8333-444455556666';

function session(over) {
  return { pid: 100, sessionId: SID_A, cwd: 'C:\\dev\\repo', kind: 'interactive',
    startedAt: T0, procStart: toFiletime(T0 - 300), ...over };
}

test('filetimeToMs converts FILETIME strings and rejects junk', () => {
  assert.strictEqual(filetimeToMs(toFiletime(T0)), T0);
  assert.strictEqual(filetimeToMs('134363750278942958') > 0, true);
  for (const bad of [null, undefined, '', 'abc', '-5', '1.5', {}, '0']) assert.strictEqual(filetimeToMs(bad), null);
});

test('parseSessionFile keeps valid files and drops malformed ones', () => {
  const ok = parseSessionFile(JSON.stringify({ pid: 35356, sessionId: SID_A, cwd: 'C:\\dev\\x',
    startedAt: T0, procStart: '134363750278942958', kind: 'interactive', extra: 1 }));
  assert.deepStrictEqual(ok, { pid: 35356, sessionId: SID_A, cwd: 'C:\\dev\\x', kind: 'interactive',
    startedAt: T0, procStart: '134363750278942958' });
  assert.strictEqual(parseSessionFile('{not json'), null);
  assert.strictEqual(parseSessionFile('null'), null);
  assert.strictEqual(parseSessionFile(JSON.stringify({ pid: 1, sessionId: 'x; rm', cwd: 'C:\\' })), null);
  assert.strictEqual(parseSessionFile(JSON.stringify({ pid: '1', sessionId: SID_A, cwd: 'C:\\' })), null);
  assert.strictEqual(parseSessionFile(JSON.stringify({ pid: 1, sessionId: SID_A })), null);
});

test('filterCandidates matches folder, kind, start time and skips claimed pids', () => {
  const list = [
    session({ pid: 1 }),
    session({ pid: 2, cwd: 'c:/dev/REPO/'.replace(/\//g, '\\') }),
    session({ pid: 3, cwd: 'C:\\dev\\other' }),
    session({ pid: 4, kind: 'print' }),
    session({ pid: 5, startedAt: T0 - 5000 }),
    session({ pid: 6, startedAt: null }),
    session({ pid: 7 })
  ];
  const got = filterCandidates(list, { sinceMs: T0 + 1000, cwd: 'C:\\dev\\repo\\', claimedPids: new Set([7]) });
  assert.deepStrictEqual(got.map(s => s.pid), [1, 2]);
  assert.deepStrictEqual(filterCandidates(list, { sinceMs: NaN, cwd: 'C:\\dev\\repo' }), []);
  assert.deepStrictEqual(filterCandidates(list, { sinceMs: T0, cwd: '' }), []);
});

test('parseProcessSnapshot reads pid,ppid,filetime,name lines', () => {
  const procs = parseProcessSnapshot(`4,0,,System\r\n200,10,${toFiletime(T0)},claude.exe\r\ngarbage\r\n201,200,${toFiletime(T0)},My, App.exe\n`);
  assert.strictEqual(procs.size, 3);
  assert.deepStrictEqual(procs.get(200), { pid: 200, ppid: 10, createdMs: T0, name: 'claude.exe' });
  assert.strictEqual(procs.get(201).name, 'my, app.exe');
  assert.strictEqual(procs.get(4).createdMs, null);
});

function snapshot(rows) {
  return parseProcessSnapshot(rows.map(([pid, ppid, ms, name]) => `${pid},${ppid},${ms == null ? '' : toFiletime(ms)},${name}`).join('\n'));
}

test('pickByAncestry picks the candidate under the pane shell', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],          // this pane's shell
    [20, 1, T0 - 60000, 'pwsh.exe'],          // other pane's shell
    [100, 10, T0 - 300, 'claude.exe'],
    [200, 20, T0 - 200, 'claude.exe']
  ]);
  const a = session({ pid: 100 });
  const b = session({ pid: 200, sessionId: SID_B, procStart: toFiletime(T0 - 200) });
  assert.strictEqual(pickByAncestry([a, b], procs, 10), a);
  assert.strictEqual(pickByAncestry([a, b], procs, 20), b);
  assert.strictEqual(pickByAncestry([a, b], procs, 30), null);
});

test('pickByAncestry follows claude.cmd -> cmd -> node and prefers the outer claude', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [11, 10, T0 - 400, 'cmd.exe'],
    [100, 11, T0 - 300, 'node.exe'],          // outer claude, 2 hops
    [101, 100, T0 + 5000, 'bash.exe'],
    [102, 101, T0 + 5100, 'node.exe']         // claude started by claude, 4 hops
  ]);
  const outer = session({ pid: 100 });
  const inner = session({ pid: 102, sessionId: SID_B, startedAt: T0 + 5200, procStart: toFiletime(T0 + 5100) });
  assert.strictEqual(pickByAncestry([inner, outer], procs, 10), outer);
});

test('pickByAncestry rejects reused pids, wrong names and too-deep chains', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [100, 10, T0 + 600000, 'claude.exe'],     // pid reused long after the file was written
    [101, 10, T0 - 300, 'notepad.exe'],
    [102, 10, null, 'claude.exe'],
    [11, 10, 0, 'a'], [12, 11, 0, 'b'], [13, 12, 0, 'c'], [14, 13, 0, 'd'],
    [103, 14, T0 - 300, 'claude.exe']         // 5 hops
  ]);
  for (const pid of [100, 101, 102, 103, 999]) assert.strictEqual(pickByAncestry([session({ pid })], procs, 10), null, String(pid));
  // startedAt alone is enough when procStart is missing or unparseable.
  const procs2 = snapshot([[10, 1, T0 - 60000, 'pwsh.exe'], [100, 10, T0 - 3000, 'bun.exe']]);
  assert.ok(pickByAncestry([session({ pid: 100, procStart: null })], procs2, 10));
  const procs3 = snapshot([[10, 1, T0 - 60000, 'pwsh.exe'], [100, 10, T0 - 8000, 'bun.exe']]);
  assert.strictEqual(pickByAncestry([session({ pid: 100, procStart: 'junk' })], procs3, 10), null);
});

test('pickByAncestry refuses to choose between equally close matches', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [100, 10, T0 - 300, 'claude.exe'],
    [200, 10, T0 - 300, 'claude.exe']
  ]);
  assert.strictEqual(pickByAncestry([session({ pid: 100 }), session({ pid: 200, sessionId: SID_B })], procs, 10), null);
});

test('pickByAncestry survives a parent-pid cycle', () => {
  const procs = snapshot([[100, 101, T0 - 300, 'claude.exe'], [101, 100, T0 - 300, 'x']]);
  assert.strictEqual(pickByAncestry([session({ pid: 100 })], procs, 10), null);
});

// ----- PaneSessionTracker: the decision main.js makes per poll -----
const { PaneSessionTracker, MAX_FAILS } = require('../claudeSessions');

// Two panes (shells 10 and 20) each start Claude in the same folder, a second apart.
function twoPanes() {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [20, 1, T0 - 60000, 'pwsh.exe'],
    [100, 10, T0 - 300, 'claude.exe'],
    [200, 20, T0 + 700, 'claude.exe']
  ]);
  const a = session({ pid: 100 });
  const b = session({ pid: 200, sessionId: SID_B, startedAt: T0 + 1000, procStart: toFiletime(T0 + 700) });
  return { procs, a, b };
}

test('tracker resolves two same-folder sessions by ancestry, whichever pane polls first', () => {
  const { procs, a, b } = twoPanes();
  const t = new PaneSessionTracker();
  // Pane B polls first and sees both files; it must not take A's.
  const candB = t.candidates('ptyB', [a, b], { sinceMs: T0 + 900, cwd: 'C:\\dev\\repo' });
  assert.deepStrictEqual(candB.map(s => s.pid).sort(), [100, 200]);
  assert.strictEqual(t.resolve('ptyB', candB, procs, { sinceMs: T0 + 900, shellPid: 20 }), b);
  // A lone candidate still goes through ancestry: pane A sees only its own after B claimed 200.
  const candA = t.candidates('ptyA', [a, b], { sinceMs: T0 - 100, cwd: 'C:\\dev\\repo' });
  assert.deepStrictEqual(candA.map(s => s.pid), [100]);
  assert.strictEqual(t.resolve('ptyA', candA, procs, { sinceMs: T0 - 100, shellPid: 10 }), a);
});

test('tracker rejects a lone candidate from an external terminal or a reused pid', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [30, 1, T0 - 60000, 'WindowsTerminal.exe'],
    [100, 30, T0 - 300, 'claude.exe'],         // external terminal's claude
    [300, 10, T0 + 900000, 'node.exe']         // reused pid of a stale file
  ]);
  const t = new PaneSessionTracker();
  assert.strictEqual(t.resolve('p', [session({ pid: 100 })], procs, { sinceMs: T0, shellPid: 10 }), null);
  assert.strictEqual(t.resolve('p', [session({ pid: 300 })], procs, { sinceMs: T0, shellPid: 10 }), null);
  assert.strictEqual(t.cached('p', T0), null);
});

test('tracker prefers the outer claude over one it started', () => {
  const procs = snapshot([
    [10, 1, T0 - 60000, 'pwsh.exe'],
    [100, 10, T0 - 300, 'claude.exe'],
    [101, 100, T0 + 5000, 'bash.exe'],
    [102, 101, T0 + 5100, 'claude.exe']
  ]);
  const outer = session({ pid: 100 });
  const inner = session({ pid: 102, sessionId: SID_B, startedAt: T0 + 5200, procStart: toFiletime(T0 + 5100) });
  const t = new PaneSessionTracker();
  assert.strictEqual(t.resolve('p', [inner, outer], procs, { sinceMs: T0, shellPid: 10 }), outer);
});

test('tracker gives up after MAX_FAILS failed lookups for one run, resets for the next', () => {
  const t = new PaneSessionTracker();
  const cand = [session({ pid: 100 })];
  for (let i = 0; i < MAX_FAILS; i++) {
    assert.strictEqual(t.givenUp('p', T0), false);
    assert.strictEqual(t.resolve('p', cand, null, { sinceMs: T0, shellPid: 10 }), null);
  }
  assert.strictEqual(t.givenUp('p', T0), true);
  assert.strictEqual(t.givenUp('p', T0 + 1), false);   // a new Claude run
  assert.strictEqual(t.givenUp('other', T0), false);
  t.forget('p');
  assert.strictEqual(t.givenUp('p', T0), false);
});

test('tracker cache: verified by pid+procStart, dropped on change or new run', () => {
  const { procs, a } = twoPanes();
  const t = new PaneSessionTracker();
  t.resolve('p', [a], procs, { sinceMs: T0, shellPid: 10 });
  assert.ok(t.cached('p', T0));
  // /clear changes the id in place: still this process.
  const cleared = { ...a, sessionId: SID_B };
  assert.strictEqual(t.verifyCached('p', cleared), cleared);
  // procStart changed: the pid now belongs to something else.
  assert.strictEqual(t.verifyCached('p', { ...a, procStart: toFiletime(T0 + 99999) }), null);
  assert.strictEqual(t.cached('p', T0), null);
  t.resolve('p', [a], procs, { sinceMs: T0, shellPid: 10 });
  assert.strictEqual(t.verifyCached('p', null), null);   // file gone
  t.resolve('p', [a], procs, { sinceMs: T0, shellPid: 10 });
  assert.strictEqual(t.cached('p', T0 + 5), null);       // new run
  // A claimed pid is excluded from other panes' candidates.
  t.resolve('p', [a], procs, { sinceMs: T0, shellPid: 10 });
  assert.deepStrictEqual(t.candidates('q', [a], { sinceMs: T0, cwd: 'C:\\dev\\repo' }), []);
});

const iso = (ms) => new Date(ms).toISOString();
const asst = (ms, stop, extra) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { stop_reason: stop, content: [] }, ...extra });
const usr = (ms, content, extra) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content }, ...extra });
const toolResult = (ms) => usr(ms, [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]);

test('lastTurnEnd: end_turn last gives its time', () => {
  const r = lastTurnEnd([usr(T0, 'hi'), asst(T0 + 1000, 'tool_use'), toolResult(T0 + 2000), asst(T0 + 3000, 'end_turn')]);
  assert.deepStrictEqual(r, { endedAt: T0 + 3000, active: false });
});

test('lastTurnEnd: tool_use or tool_result last means still active', () => {
  assert.deepStrictEqual(lastTurnEnd([asst(T0, 'end_turn'), usr(T0 + 1, 'again'), asst(T0 + 2, 'tool_use')]), { endedAt: null, active: true });
  assert.deepStrictEqual(lastTurnEnd([asst(T0, 'end_turn'), usr(T0 + 1, [{ type: 'text', text: 'again' }]), toolResult(T0 + 2)]), { endedAt: null, active: true });
});

test('lastTurnEnd: a user prompt after end_turn starts a new turn', () => {
  assert.deepStrictEqual(lastTurnEnd([asst(T0, 'end_turn'), usr(T0 + 5, 'next')]), { endedAt: null, active: true });
  assert.deepStrictEqual(lastTurnEnd([asst(T0, 'end_turn'), usr(T0 + 5, '<task-notification>done</task-notification>')]), { endedAt: null, active: true });
});

test('lastTurnEnd: API error and Esc interrupt end the turn', () => {
  assert.deepStrictEqual(lastTurnEnd([usr(T0, 'hi'), asst(T0 + 9, null, { isApiErrorMessage: true })]), { endedAt: T0 + 9, active: false });
  assert.deepStrictEqual(lastTurnEnd([usr(T0, 'hi'), usr(T0 + 7, [{ type: 'text', text: '[Request interrupted by user]' }])]), { endedAt: T0 + 7, active: false });
  assert.deepStrictEqual(lastTurnEnd([usr(T0, 'hi'), usr(T0 + 7, '[Request interrupted by user for tool use]')]), { endedAt: T0 + 7, active: false });
});

test('lastTurnEnd: a turn started by bash mode, a hand-back or a command is active once Claude answers', () => {
  const done = asst(T0, 'end_turn');
  assert.deepStrictEqual(lastTurnEnd([done, usr(T0 + 1, '<bash-input>ls</bash-input>'), usr(T0 + 2, '<bash-stdout>a</bash-stdout>'), asst(T0 + 3, 'tool_use')]),
    { endedAt: null, active: true });
  assert.deepStrictEqual(lastTurnEnd([done, usr(T0 + 1, 'Another Claude session sent a message: x', { isMeta: true }), asst(T0 + 3, 'tool_use')]),
    { endedAt: null, active: true });
  assert.deepStrictEqual(lastTurnEnd([done, usr(T0 + 1, '<command-name>/review</command-name>'), asst(T0 + 3, null)]),
    { endedAt: null, active: true });
});

test('lastTurnEnd: stop_sequence and refusal end the turn', () => {
  assert.deepStrictEqual(lastTurnEnd([usr(T0, 'hi'), asst(T0 + 4, 'stop_sequence')]), { endedAt: T0 + 4, active: false });
  assert.deepStrictEqual(lastTurnEnd([usr(T0, 'hi'), asst(T0 + 4, 'refusal')]), { endedAt: T0 + 4, active: false });
});

test('lastTurnEnd: slash commands, bash mode, meta and caveats do not start a turn', () => {
  const done = asst(T0, 'end_turn');
  for (const text of ['<command-name>/model</command-name>', '<command-message>x</command-message>', '<local-command-stdout>Set model</local-command-stdout>',
    '<local-command-caveat>Caveat</local-command-caveat>', '<bash-input>ls</bash-input>', '<bash-stdout>a</bash-stdout>', '<bash-stderr></bash-stderr>',
    '<system-reminder>x</system-reminder>']) {
    assert.deepStrictEqual(lastTurnEnd([done, usr(T0 + 1, text)]), { endedAt: T0, active: false }, text);
  }
  assert.deepStrictEqual(lastTurnEnd([done, usr(T0 + 1, 'injected', { isMeta: true })]), { endedAt: T0, active: false });
});

test('lastTurnEnd: ignores sidechain entries, noise entries and malformed lines', () => {
  const r = lastTurnEnd([asst(T0, 'end_turn'), asst(T0 + 50, 'end_turn', { isSidechain: true }),
    usr(T0 + 60, 'sub prompt', { isSidechain: true }), '{broken', '', JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: iso(T0 + 70) }),
    JSON.stringify({ type: 'attachment', timestamp: iso(T0 + 80) })]);
  assert.deepStrictEqual(r, { endedAt: T0, active: false });
});

test('lastTurnEnd: empty input or missing timestamp', () => {
  assert.deepStrictEqual(lastTurnEnd([]), { endedAt: null, active: false });
  assert.deepStrictEqual(lastTurnEnd(['', 'nope']), { endedAt: null, active: false });
  assert.deepStrictEqual(lastTurnEnd([JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } })]), { endedAt: null, active: false });
});
