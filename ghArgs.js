// Pure argument building for `gh pr merge` (no electron, unit-tested).
//
// Every value that reaches the gh command line is validated here, so a crafted value
// can't smuggle a flag in. github.js runs the result with an args array and no shell.

// Same semantics as github.js REPO_RE / validNumber.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const METHODS = ['squash', 'merge', 'rebase'];

// Modes:
//   disableAuto  -> only --disable-auto (repo + number)
//   queue        -> repo requires a merge queue: no method, never --delete-branch
//   auto         -> --auto with a method, never --delete-branch (the repo's own
//                   "delete branch on merge" setting applies)
//   otherwise    -> direct merge with method, optional --delete-branch
// --match-head-commit is passed whenever we merge, so a push after the dialog opened
// can't be merged unreviewed.
function buildMergeArgs({ repo, number, method, deleteBranch, auto, disableAuto, matchHead, queue } = {}) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw new Error('bad repo');
  const n = Number(number);
  if (number === '' || number == null || !Number.isInteger(n) || n <= 0 || n >= 1e9) throw new Error('bad number');
  const args = ['pr', 'merge', String(n), '--repo', repo];
  if (disableAuto === true) { args.push('--disable-auto'); return args; }
  if (typeof matchHead !== 'string' || !SHA_RE.test(matchHead)) throw new Error('bad head commit');
  if (queue === true) {
    args.push('--match-head-commit', matchHead);
    return args;
  }
  if (!METHODS.includes(method)) throw new Error('bad method');
  args.push('--' + method);
  if (auto === true) args.push('--auto');
  else if (deleteBranch === true) args.push('--delete-branch');
  args.push('--match-head-commit', matchHead);
  return args;
}

module.exports = { buildMergeArgs };
