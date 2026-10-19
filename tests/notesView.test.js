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

test('notesToMarkdown: image lines follow their item when the image dir is known', () => {
  const repo = {
    stages: ['dev'],
    items: [
      { text: 'shot', done: false, stages: {}, branch: 'feat/y',
        images: [{ id: 'abc12345', ext: 'png', name: 'screen.png' }, { id: 'def67890', ext: 'jpg' }] },
      { text: 'plain', done: true, stages: { dev: 1 } }
    ]
  };
  assert.strictEqual(notesToMarkdown(repo, 'r', 'C:\\Users\\me\\AppData\\note-images'), [
    '# Notes — r', '',
    '## Open', '- [ ] shot [feat/y]',
    '  ![screen.png](<C:\\Users\\me\\AppData\\note-images\\abc12345.png>)',
    '  ![def67890](<C:\\Users\\me\\AppData\\note-images\\def67890.jpg>)', '',
    '## Done', '- [x] plain (dev ✓)', ''
  ].join('\n'));
  assert.ok(notesToMarkdown(repo, 'r', '/home/me/note-images').includes('  ![screen.png](</home/me/note-images/abc12345.png>)'));
});

test('notesToMarkdown: no image lines without an image dir; bad entries are skipped', () => {
  const repo = { stages: [], items: [{ text: 't', done: false, images: [{ id: 'abc12345', ext: 'png' }, null, { id: 1 }] }] };
  assert.strictEqual(notesToMarkdown(repo, 'r'), '# Notes — r\n\n## Open\n- [ ] t\n');
  assert.strictEqual(notesToMarkdown(repo, 'r', ''), '# Notes — r\n\n## Open\n- [ ] t\n');
  assert.strictEqual(notesToMarkdown(repo, 'r', 'D:\\img\\'), '# Notes — r\n\n## Open\n- [ ] t\n  ![abc12345](<D:\\img\\abc12345.png>)\n');
});

test('parseNoteImage: validates the dragged JSON', () => {
  const { parseNoteImage } = win.repoNotes;
  assert.deepStrictEqual({ ...parseNoteImage('{"id":"abc12345","ext":"png","name":"a.png"}') }, { id: 'abc12345', ext: 'png', name: 'a.png' });
  assert.strictEqual(parseNoteImage('{"id":"abc12345","ext":"png"}').name, undefined);
  for (const bad of ['nope', '{"id":"short","ext":"png"}', '{"id":"ABC12345","ext":"png"}', '{"id":"../../etc12","ext":"png"}',
    '{"id":"abc12345","ext":"exe"}', '{"id":"abc12345","ext":"png","name":3}', 'null']) {
    assert.strictEqual(parseNoteImage(bad), null, bad);
  }
});
