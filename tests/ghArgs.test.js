const test = require('node:test');
const assert = require('node:assert');
const { buildMergeArgs, buildCopilotReviewArgs } = require('../ghArgs');

const SHA = 'a'.repeat(40);
const base = { repo: 'octo/repo.js', number: 12, method: 'squash', matchHead: SHA };

test('direct merge: method, optional delete-branch, match-head', () => {
  assert.deepStrictEqual(buildMergeArgs(base),
    ['pr', 'merge', '12', '--repo', 'octo/repo.js', '--squash', '--match-head-commit', SHA]);
  assert.deepStrictEqual(buildMergeArgs({ ...base, method: 'rebase', deleteBranch: true }),
    ['pr', 'merge', '12', '--repo', 'octo/repo.js', '--rebase', '--delete-branch', '--match-head-commit', SHA]);
  assert.ok(buildMergeArgs({ ...base, method: 'merge' }).includes('--merge'));
  assert.ok(!buildMergeArgs({ ...base, deleteBranch: false }).includes('--delete-branch'));
  assert.strictEqual(buildMergeArgs({ ...base, number: '7' })[2], '7');
});

test('auto: --auto with method, never --delete-branch', () => {
  const a = buildMergeArgs({ ...base, auto: true, deleteBranch: true });
  assert.ok(a.includes('--auto') && a.includes('--squash') && !a.includes('--delete-branch'));
  assert.ok(a.includes('--match-head-commit'));
});

test('queue: no method, no delete-branch, no auto', () => {
  const a = buildMergeArgs({ repo: 'o/r', number: 3, queue: true, method: 'squash', deleteBranch: true, auto: true, matchHead: SHA });
  assert.deepStrictEqual(a, ['pr', 'merge', '3', '--repo', 'o/r', '--match-head-commit', SHA]);
  assert.throws(() => buildMergeArgs({ repo: 'o/r', number: 3, queue: true }), /head/);
});

test('disableAuto: only repo and number, no matchHead needed', () => {
  assert.deepStrictEqual(buildMergeArgs({ repo: 'o/r', number: 4, disableAuto: true, method: 'squash', deleteBranch: true }),
    ['pr', 'merge', '4', '--repo', 'o/r', '--disable-auto']);
});

test('rejects bad input', () => {
  for (const repo of [undefined, '', 'norepo', 'a/b/c', 'a/b c', 'a/b;rm', 42]) {
    assert.throws(() => buildMergeArgs({ ...base, repo }), /repo/, String(repo));
  }
  for (const number of [0, -1, 1.5, 'x', '', null, undefined, 1e9, NaN]) {
    assert.throws(() => buildMergeArgs({ ...base, number }), /number/, String(number));
  }
  for (const method of [undefined, '', 'SQUASH', '--admin', 'fast-forward']) {
    assert.throws(() => buildMergeArgs({ ...base, method }), /method/, String(method));
  }
  for (const matchHead of [undefined, '', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41), '--admin']) {
    assert.throws(() => buildMergeArgs({ ...base, matchHead }), /head/, String(matchHead));
  }
  assert.throws(() => buildMergeArgs(), /repo/);
});

test('copilot review args: valid input', () => {
  assert.deepStrictEqual(buildCopilotReviewArgs({ repo: 'octo/repo.js', number: 12 }),
    ['pr', 'edit', '12', '--repo', 'octo/repo.js', '--add-reviewer', '@copilot']);
  assert.strictEqual(buildCopilotReviewArgs({ repo: 'a/b', number: '7' })[2], '7');
});

test('copilot review args: bad repo and number throw', () => {
  for (const repo of ['-x/y', 'a/b c', 'nope', '', null, undefined]) {
    assert.throws(() => buildCopilotReviewArgs({ repo, number: 1 }), /bad repo/);
  }
  for (const number of [0, -1, '1;x', '', null, 1e9]) {
    assert.throws(() => buildCopilotReviewArgs({ repo: 'a/b', number }), /bad number/);
  }
});
