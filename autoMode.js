// Auto-mode shell command gate for chat panes. Pure: no I/O, no Electron —
// main.js asks autoAllowsCommand() whether a Bash call may run without a prompt.

// ----- Auto mode -----
// Auto mode = accept edits, plus shell commands that only inspect state or run the
// project's own checks. Everything else still asks. The allowlist is on the command
// head (plus a second word for subcommand-scoped tools like git), and any command
// containing a risky token is asked about regardless of its head, so an allowlisted
// head can't smuggle something through a pipe or a chained `&&`.
const AUTO_SAFE_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'type', 'head', 'tail', 'wc',
  'find', 'findstr', 'grep', 'rg', 'where', 'which', 'tree', 'stat',
  'date', 'whoami', 'hostname', 'printenv', 'set',
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

// gh is allowlisted on subcommand + verb, so new or forgotten write verbs ask by
// default. `gh api` counts as a read only without method/body flags (any -f/-F
// turns it into a POST). Quoting or expansion after `api` asks too: bash can
// assemble a flag from pieces (`""-XPOST`, `-''X`, `${A:--XDELETE}`) that no
// token check would see.
const AUTO_SAFE_GH = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  run: new Set(['view', 'list', 'watch']),
  repo: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  search: new Set(['repos', 'issues', 'prs', 'commits', 'code'])
};
// Short flags can be bundled (`-iXPOST`), so any -…X/f/F counts.
const GH_API_WRITE_FLAG = /(^|\s)-[a-zA-Z]*[XfF]|--method|--field|--raw-field|--input/;

function autoAllowsGh(words) {
  const sub = (words[1] || '').toLowerCase();
  if (sub === 'api') {
    // Quotes are fine (`--jq '.[].body'`) once stripped, since that is how the shell
    // joins pieces; escapes and expansion are not.
    const rest = words.slice(2).join(' ');
    return words.length > 2 && !/[$\\`]/.test(rest) && !GH_API_WRITE_FLAG.test(rest.replace(/["']/g, ''));
  }
  const verbs = AUTO_SAFE_GH[sub];
  return !!verbs && verbs.has((words[2] || '').toLowerCase());
}

// Substrings that force a prompt wherever they appear in the command line.
const AUTO_RISKY = [
  /\brm\b/i, /\brmdir\b/i, /\bdel\b/i, /\berase\b/i, /remove-item/i,
  /\bmv\b/i, /\bmove\b/i, /\bformat\b/i, /\bdd\b/i, /\bmkfs/i,
  /\bsudo\b/i, /\brunas\b/i, /\bicacls\b/i, /\bchmod\b/i, /\bchown\b/i,
  /\bcurl\b/i, /\bwget\b/i, /invoke-webrequest/i, /invoke-restmethod/i,
  /\bssh\b/i, /\bscp\b/i, /\bftp\b/i, /\bnc\b/i,
  /\bshutdown\b/i, /\brestart-computer\b/i, /\breg\b\s/i, /\bschtasks\b/i,
  /\bsc\b\s/i, /\btaskkill\b/i, /stop-process/i, /\bkill\b/i,
  /\bnpm\s+(i|install|publish|link|unpublish)\b/i,
  /\bgit\s+(push|reset|clean|rebase|checkout|switch|restore|filter-branch)\b/i,
  // Allowlisted git/find heads that still have writing forms.
  /\bgit\s+branch\b.*\s(--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--edit-description|-[a-zA-Z]*[dDmMcCfu])/,
  /\bgit\s+stash\s+(drop|clear|pop|apply|push|save|branch|store|create)\b/i,
  /\bgit\s+remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i,
  /\bfind\b.*\s-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)\b/i,
  // gh: reads are allowlisted in AUTO_SAFE_GH; these stay as a second line of defence.
  /\bgh\s+api\b.*\s(-X|--method)[\s=]*(POST|PUT|PATCH|DELETE)\b/i,
  /\bgh\s+api\b.*\s(-f|-F|--field|--raw-field|--input)\b/,
  /\bgh\s+(pr|issue)\s+(merge|close|reopen|delete|edit|comment|create|review|ready|lock|transfer|pin|develop|checkout)\b/i,
  /\bgh\s+repo\s+(delete|archive|rename|edit|create|fork|sync)\b/i,
  /\bgh\s+run\s+(cancel|delete|rerun)\b/i,
  />\s*\S/, />>/,               // output redirection writes files
  // Anything the segment split below can't see into: a lone `&` (background /
  // PowerShell call operator), newlines, and command/process substitution —
  // including PowerShell's `(cmd)` / `@(cmd)` grouping at the start of an argument.
  /(^|[^&])&(?!&)/, /[\r\n]/, /`/, /\$\(/, /\$\{/, /<\(/, /(^|[\s,=:\]])@?\(/,
  /\biex\b/i, /invoke-expression/i, /\beval\b/i,
  /\|\s*(sh|bash|pwsh|powershell|cmd)\b/i
];

function autoAllowsCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (AUTO_RISKY.some((re) => re.test(cmd))) return false;

  // Every segment of a chained command has to clear the bar on its own.
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;

  return segments.every((seg) => {
    const words = seg.split(/\s+/);
    const head = (words[0] || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop()
      .replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    if (head === 'gh') return autoAllowsGh(words);
    const subs = AUTO_SAFE_SUBCOMMANDS[head];
    if (subs) {
      const sub = (words[1] || '').toLowerCase();
      return subs.has(sub);
    }
    return AUTO_SAFE_COMMANDS.has(head);
  });
}

module.exports = { autoAllowsCommand };
