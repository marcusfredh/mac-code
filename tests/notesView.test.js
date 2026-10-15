const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// notesView.js is a browser IIFE; load it with a minimal window stub (no DOM needed
// until a panel is created).
const win = { addEventListener() {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'notesView.js'), 'utf8'), { window: win, Promise });
const { notesToMarkdown } = win.repoNotes;

test('notesToMarkdown: open/done sections, stage marks, branch, multi-line, scratchpad', () => {
  const repo = {
    stages: ['dev', 'prod'], scratch: 'remember this',
    items: [
      { text: 'first\nsecond line', done: false, stages: {}, branch: 'feat/x' },
      { text: 'shipped', done: true, stages: { dev: 1, prod: 2 } },
      { text: 'in dev', done: false, stages: { dev: 1 } }
    ]
  };
  assert.strictEqual(notesToMarkdown(repo, 'acme/app'), [
    '# Notes — acme/app', '',
    '## Open', '- [ ] first\n  second line [feat/x]', '- [ ] in dev (dev ✓)', '',
    '## Done', '- [x] shipped (dev ✓, prod ✓)', '',
    '## Scratchpad', '', 'remember this', ''
  ].join('\n'));
});

test('notesToMarkdown: omits empty sections', () => {
  assert.strictEqual(notesToMarkdown({ stages: ['dev'], items: [], scratch: '  ' }, 'r'), '# Notes — r\n');
});
