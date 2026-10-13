// Auto-mode shell command gate for chat panes. Pure: no I/O, no Electron —
// main.js asks autoAllowsCommand() whether a Bash or PowerShell call may run
// without a prompt.

// ----- Auto mode -----
// Auto mode = accept edits, plus shell commands that only inspect state or run the
// project's own checks. Everything else still asks.
//
// Two kinds of allowed command, with different guarantees:
// - Read tools (ls, cat, grep, git/gh reads, ...): the gate is meant to be a real
//   boundary — they must not write, run other programs or reach the network
//   beyond what their read implies, even for a prompt-injected model.
// - Project-code runners (node, python, npm test/run, test runners, compilers):
//   accepted risk. Edit/Write are already auto-allowed in this mode, so a model can
//   always write a file and run it; filtering these tools' arguments would only
//   look like a boundary. Auto mode means "Claude may run code in this project".
//
// The same string may run in bash or in PowerShell, and both have far more ways to
// run code inside an argument than a regex can follow (substitution, brace
// expansion, comma arrays, `a(cmd)`, script blocks, member calls, globs). So the
// gate does not try to understand the shell. It tokenizes the command itself and
// only lets through commands made of characters that are plain text in both
// shells; anything else asks. The allowlist and risky checks then run on the
// de-quoted words, which are what the program will actually receive.

// Outside quotes: letters, digits and punctuation that neither shell treats
// specially in argument position. No $ ` \ ' " ( ) { } [ ] , @ * ? < > # ! & ^.
const BARE_CHAR = /[A-Za-z0-9_\-./:=+%~]/;
// Inside quotes: printable ASCII only (PowerShell also closes quotes on Unicode
// smart quotes); double quotes additionally exclude what either shell expands there.
const QUOTED_CHAR = /^[\x20-\x7E]$/;
const DQ_SPECIAL = /[$`\\!]/;

// Splits into segments (on && || | ;) of de-quoted words, or returns null when the
// command contains anything outside the plain-text subset.
function tokenize(command) {
  const segments = [];
  let words = [];
  let word = null;   // null = between words
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endSegment = () => {
    endWord();
    if (!words.length) return false;
    segments.push(words); words = [];
    return true;
  };
  const s = command;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') { endWord(); continue; }
    // `2>&1` as a whole word only merges stderr, in both shells.
    if (word === null && s.startsWith('2>&1', i) && /^[\s|;&]?$/.test(s[i + 4] || '')) { i += 3; continue; }
    if (c === '&' || c === '|') {
      if (s[i + 1] === c) i++;            // && or ||
      else if (c === '&') return null;    // lone & (background / call operator)
      if (!endSegment()) return null;
      continue;
    }
    if (c === ';') { if (!endSegment()) return null; continue; }
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1);
      if (close < 0) return null;
      const body = s.slice(i + 1, close);
      for (const ch of body) {
        if (!QUOTED_CHAR.test(ch)) return null;
        if (c === '"' && DQ_SPECIAL.test(ch)) return null;
      }
      word = (word || '') + body;
      i = close;
      continue;
    }
    if (!BARE_CHAR.test(c)) return null;
    word = (word || '') + c;
  }
  endSegment();
  return segments.length ? segments : null;
}

// Read tools: arguments are checked in argsAllowed.
const AUTO_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc',
  'find', 'findstr', 'grep', 'rg', 'which', 'tree', 'stat',
  'date', 'whoami', 'hostname', 'printenv'
]);
// Project-code runners: accepted risk, arguments not checked (see top).
const AUTO_PROJECT_CODE_COMMANDS = new Set([
  'node', 'python', 'python3', 'py', 'dotnet', 'go', 'cargo', 'tsc',
  'eslint', 'prettier', 'pytest', 'jest', 'vitest'
]);

// Command heads whose safety depends on the subcommand.
const AUTO_SAFE_SUBCOMMANDS = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'blame',
                'describe', 'rev-parse', 'ls-files', 'shortlog', 'stash']),
  npm: new Set(['test', 'run', 'ls', 'list', 'view', 'outdated', 'why', 'audit']),
  pnpm: new Set(['test', 'run', 'ls', 'list', 'why', 'outdated']),
  yarn: new Set(['test', 'run', 'list', 'why', 'outdated'])
};

// git subcommands that also have writing forms: only their read forms pass.
// Long options go through hasLongOption, since git accepts abbreviations.
const GIT_BRANCH_WRITE_LONG = ['--delete', '--move', '--copy', '--force', '--set-upstream-to',
  '--set-upstream', '--unset-upstream', '--edit-description', '--track', '--no-track',
  '--create-reflog', '--recurse-submodules'];
const GIT_BRANCH_WRITE_SHORT = /^-[a-zA-Z]*[dDmMcCfut]/;
const GIT_BRANCH_FILTER = /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
function gitReadOnly(sub, args) {
  if (sub === 'stash') {
    // `stash list` takes log options and `stash show` diff options, --output included.
    if (args[0] !== 'list' && args[0] !== 'show') return false;
    return !hasLongOption(args.slice(1), GIT_READ_RISKY);
  }
  if (sub === 'remote') {
    if (args.every((a) => a === '-v' || a === '--verbose')) return true;
    return args[0] === 'show' || args[0] === 'get-url';
  }
  if (sub === 'branch') {
    // A bare name creates a branch, unless it follows a list filter.
    let listing = false;
    for (const a of args) {
      if (a.startsWith('-')) {
        if (GIT_BRANCH_WRITE_SHORT.test(a) || hasLongOption([a], GIT_BRANCH_WRITE_LONG)) return false;
        if (GIT_BRANCH_FILTER.test(a)) listing = true;
      } else if (!listing) return false;
    }
    return true;
  }
  return true;
}

// gh is allowlisted on subcommand + verb, so new or forgotten write verbs ask by
// default. `gh api` flags are allowlisted too: anything that sets the method, body,
// headers or host asks.
const AUTO_SAFE_GH = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  run: new Set(['view', 'list', 'watch']),
  repo: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  search: new Set(['repos', 'issues', 'prs', 'commits', 'code'])
};
const GH_API_FLAGS = new Set(['--jq', '-q', '--paginate', '--slurp', '--template', '-t',
  '--include', '-i', '--silent', '--verbose', '--cache']);

function autoAllowsGh(words) {
  const sub = (words[1] || '').toLowerCase();
  if (sub === 'api') {
    return words.length > 2 &&
      words.slice(2).every((w) => !w.startsWith('-') || GH_API_FLAGS.has(w.split('=')[0]));
  }
  const verbs = AUTO_SAFE_GH[sub];
  return !!verbs && verbs.has((words[2] || '').toLowerCase());
}

// True if any arg is one of these long options or an abbreviation of one (git
// accepts any unambiguous prefix, e.g. `--ext` for `--ext-diff`). Exact names of
// other, harmless options git matches first (`--text`) are not abbreviations.
const EXACT_SAFE_LONG = new Set(['--text']);
function hasLongOption(args, names) {
  return args.some((a) => {
    if (!a.startsWith('--')) return false;
    const n = a.split('=')[0];
    if (EXACT_SAFE_LONG.has(n)) return false;
    return n.length > 2 && names.some((f) => f.startsWith(n));
  });
}

// Options that make an allowlisted read run a program, write a file or read
// outside the repo.
const GIT_READ_RISKY = ['--output', '--ext-diff', '--textconv', '--no-index', '--contents'];
const FIND_RISKY = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fprint', '-fprint0', '-fprintf', '-fls']);
function argsAllowed(head, sub, args) {
  if (head === 'git') {
    if (['log', 'diff', 'show', 'blame', 'shortlog'].includes(sub) && hasLongOption(args, GIT_READ_RISKY)) return false;
    return gitReadOnly(sub, args);
  }
  if (head === 'npm' && sub === 'audit') return !args.includes('fix');
  if (head === 'find') return !args.some((a) => FIND_RISKY.has(a.toLowerCase()));
  if (head === 'rg') return !hasLongOption(args, ['--pre', '--pre-glob']);
  // GNU tree bundles short options; -o writes a file, -R writes HTML per directory.
  if (head === 'tree') return !args.some((a) => /^-[^-]*[oR]/.test(a));
  return true;
}

// A path as the head only counts for project-local tool shims; `./x/git` is not git.
const HEAD_PATH_OK = /^(\.\/)?node_modules\/\.bin\/[^/]+$/;
// PowerShell's stop-parsing token hands the rest of the line to the program raw.
const PS_STOP_PARSING = /(^|[\s;|&])--%(?=[\s;|&]|$)/;

function autoAllowsCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd || PS_STOP_PARSING.test(cmd)) return false;
  const segments = tokenize(cmd);
  if (!segments) return false;

  // Every segment of a chained command has to clear the bar on its own.
  return segments.every((words) => {
    if (words[0].includes('/') && !HEAD_PATH_OK.test(words[0])) return false;
    const head = words[0].split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    if (head === 'gh') return autoAllowsGh(words);
    const subs = AUTO_SAFE_SUBCOMMANDS[head];
    if (subs) {
      const sub = (words[1] || '').toLowerCase();
      return subs.has(sub) && argsAllowed(head, sub, words.slice(2));
    }
    if (AUTO_PROJECT_CODE_COMMANDS.has(head)) return true;
    return AUTO_SAFE_COMMANDS.has(head) && argsAllowed(head, '', words.slice(1));
  });
}

module.exports = { autoAllowsCommand, tokenize };
