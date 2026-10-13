const test = require('node:test');
const assert = require('node:assert');
const { autoAllowsCommand } = require('../autoMode');

const ALLOWED = [
  'git status',
  'npm test',
  'ls -la && git diff',
  'gh pr view 12',
  'gh pr list --state open',
  'gh pr diff 3',
  'gh pr checks 3',
  'gh issue view 5 --comments',
  'gh run view 1 --log',
  'gh repo view',
  'gh.exe pr view 1',
  'gh api repos/a/b/pulls',
  'gh api repos/a/b --jq .name --paginate',
  'gh pr view 1 && git status',
  "gh api repos/o/r/pulls/1/comments --jq '.[].body'",
  'git branch -a',
  'git branch --show-current',
  'git stash list',
  'git remote -v',
  'find . -name "*.js"',
  'node -e "console.log(1)"'
];

const ASKS = [
  // gh write verbs, including ones the old deny-list missed
  'gh repo deploy-key add k.pub --allow-write',
  'gh repo unarchive',
  'gh repo set-default x/y',
  'gh repo autolink create',
  'gh pr update-branch 3',
  'gh pr revert 3',
  'gh issue unpin 3',
  'gh pr merge 1',
  'GH PR MERGE 1',
  'gh secret set X',
  'gh auth token',
  'gh run download 1',
  'gh pr -R x/y merge 1',
  'gh api',
  // gh api method/body flags, plain, bundled and assembled by the shell
  'gh api -XPOST repos/a',
  'gh api repos/a -X DELETE',
  'gh api --method=GET repos/a',
  'gh api repos/a -f x=1',
  'gh api graphql -F q=1',
  'gh api repos/a -iXPOST',
  'gh api repos/a --input f.json',
  'gh api repos/o/r/hooks ""-XPOST',
  "gh api repos/o/r/hooks -''X DELETE",
  'gh api repos/o/r ${A:--XDELETE}',
  'gh api repos/o/r -\\X DELETE',
  // smuggling past the segment split
  'gh pr view 1 && gh repo deploy-key add k',
  'gh pr view 1 & gh repo deploy-key add k.pub --allow-write',
  'gh pr view 1\ngh secret set X -b y',
  'gh pr view 1\r\ngh secret set X -b y',
  'echo $(gh repo deploy-key add k --allow-write)',
  'git log `gh secret set X -b y`',
  'cat <(gh secret set X -b y)',
  'echo ${X}',
  // PowerShell grouping runs the inner command
  'echo (gh secret set X -b y)',
  'ls (gh repo deploy-key add k.pub --allow-write)',
  'echo @(gh secret set X -b y)',
  'ls -Path x,(gh secret set X)',
  // quoting still cannot assemble a gh api write flag
  'gh api repos/a "-XPOST"',
  "gh api repos/a --jq '.a' -'F' q=1",
  // allowlisted heads that execute or write
  'env gh secret set X -b y',
  'cat s.sh | env bash',
  'find . -exec gh secret set X -b y \;',
  'find . -delete',
  'git branch -D main',
  'git branch --delete main',
  'git stash clear',
  'git stash pop',
  'git remote set-url origin https://evil.example/x.git',
  // pre-existing risky tokens
  'git push',
  'ls > out.txt',
  'rm -rf x'
];

test('auto mode allows read-only commands', () => {
  for (const cmd of ALLOWED) assert.strictEqual(autoAllowsCommand(cmd), true, cmd);
});

test('auto mode asks for writes and anything it cannot see into', () => {
  for (const cmd of ASKS) assert.strictEqual(autoAllowsCommand(cmd), false, cmd);
});
