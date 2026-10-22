// Paste helpers for the terminal: turn multi-line text into one line so PSReadLine does
// not run the first line on its own. Plain script, no deps. Loaded by renderer.html
// before renderer.js; tests/pasteText.test.js covers it.
(function () {
  'use strict';

  // A comment line starts with '#', but not '#>' (end of a block comment). '<#' lines
  // don't match either, so block comments are never opened without being closed.
  const COMMENT_LINE = /^\s*#(?!>)/;

  function toOneLine(text) {
    if (typeof text !== 'string' || text === '') return '';
    const parts = [];
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = raw.replace(/\s+$/, '');
      // PowerShell line continuation: a backtick at the very end of the line.
      if (line.endsWith('`')) line = line.slice(0, -1).replace(/\s+$/, '');
      if (!line.trim()) continue;
      if (COMMENT_LINE.test(line)) continue;
      parts.push(line.trim());
    }
    return parts.join(' ').trim();
  }

  function isMultiline(text) {
    if (typeof text !== 'string') return false;
    return /[\r\n]/.test(text.replace(/[\r\n]+$/, ''));
  }

  // PowerShell's quote characters, typographic ones included (text pasted from docs).
  const DQ = '"“”„', SQ = "'‘’‚‛";

  // Scans one line: { comment } is the index of an unquoted '#', or -1; { open } is true
  // when a quote is still open at the end of the line (a string that continues on the
  // next one). Whether PowerShell reads '#' as a comment depends on parse mode ($x#c is a
  // comment, Write-Host a#c is not), so every unquoted '#' counts, URLs included. Erring
  // here only means the paste goes in unchanged; erring the other way silently drops lines.
  function scanLine(line) {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (q.includes(c)) q = null; else if (c === '`' && q === DQ) i++; continue; }
      if (c === '`') { i++; continue; }
      if (DQ.includes(c)) { q = DQ; continue; }
      if (SQ.includes(c)) { q = SQ; continue; }
      if (c === '#') return { comment: i, open: false };
    }
    return { comment: -1, open: !!q };
  }

  // Whether toOneLine keeps the meaning of the text. Joining after an inline comment would
  // comment out every following line, here-strings need their markers on own lines, and a
  // string spanning lines would lose its line breaks (and any '#' line inside it); in all
  // of these the paste goes in unchanged instead.
  function canJoin(text) {
    if (typeof text !== 'string') return false;
    const all = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
    for (const l of all) {
      if (/@["']$/.test(l) || /^\s*["']@/.test(l)) return false;
      // Checked on every line, comment lines included: an open quote here means the
      // text holds a multi-line string.
      if (l.trim() && !COMMENT_LINE.test(l) && scanLine(l).open) return false;
    }
    const lines = all.filter((l) => l.trim() && !COMMENT_LINE.test(l));
    for (let i = 0; i < lines.length - 1; i++) {
      if (scanLine(lines[i]).comment >= 0) return false;
    }
    return true;
  }

  // Plain join for "Copy as one line": no comment handling, every non-blank line kept.
  function joinLines(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\r\n?/g, '\n').split('\n')
      .map((l) => l.trim()).filter(Boolean).join(' ');
  }

  const api = { toOneLine, isMultiline, canJoin, joinLines };
  if (typeof window !== 'undefined') window.pasteText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
