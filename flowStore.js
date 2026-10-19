// Claude flows on disk: ~/.claude/flows/<slug>.json, and the skills/<slug>/SKILL.md
// compiled from them. Pure (no electron) so it can be unit-tested against a temp
// folder; main.js only wires the IPC and the native confirm around createFlowStore().
//
// Same safety rules as claudeConfig.js, and its helpers:
// - The renderer never sends paths: every path is built from a validated slug and a
//   fixed base and must be a direct child of it.
// - Optimistic concurrency: rev = sha1 of the file's bytes; a write with another rev
//   than what is on disk gets { conflict: true }.
// - Backups go to <root>/backups/mac-code/. SKILL.md writes and flow deletes always back
//   up; flow autosaves back up the first overwrite of each flow per store instance (=
//   per app session).
// - SKILL.md is only written through writeSkill(), after the injected confirm() (a
//   native dialog in main), and never through a symlink/junction (R12).
const fs = require('fs');
const path = require('path');
const {
  createClaudeConfig, quoteForDisplay, sha1, readCapped, atomicWriteText, childPath,
  createBackups, errMsg, MAX_READ_BYTES
} = require('./claudeConfig');
const {
  slugOk, validateFlow, compileFlow, defaultOrchestrateFlow, DEFAULT_HOOK_HINTS, MARKER, execError
} = require('./flowCompile');

const DEFAULT_SLUG = 'orchestrate';
const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 120;
const PREVIEW_TOTAL_CHARS = 2000;

function fail(error, extra) { return Object.assign({ ok: false, error }, extra); }
const CHANGED = 'Flödesfilen ändrades utanför Mac Code — läs om';

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function splitLines(s) {
  if (s == null || s === '') return [];
  const lines = String(s).replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// R13: the marker must be the first non-empty line after the closing frontmatter fence.
function hasMarker(text, slug) {
  const lines = stripBom(String(text)).split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] || '')) return false;
  let i = 1;
  while (i < lines.length && !/^---[ \t]*$/.test(lines[i])) i++;
  if (i >= lines.length) return false;
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    return lines[i].trim() === MARKER(slug);
  }
  return false;
}

// Line diff of old -> new (LCS):
//   { added, removed, addedLines, removedLines, ops:[{ t:' '|'+'|'-', l }] }
// or { tooLarge:true } past DIFF_CAP line pairs — never an approximation, since the
// confirm dialog must show exactly what changes.
const DIFF_CAP = 4e6;
function lineDiff(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CAP) return { tooLarge: true };
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', l: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: '-', l: a[i] }); i++; }
    else { ops.push({ t: '+', l: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', l: a[i++] });
  while (j < m) ops.push({ t: '+', l: b[j++] });
  const addedLines = ops.filter((o) => o.t === '+').map((o) => o.l);
  const removedLines = ops.filter((o) => o.t === '-').map((o) => o.l);
  return { added: addedLines.length, removed: removedLines.length, addedLines, removedLines, ops };
}

const TOO_LARGE = 'Ändringen är för stor för att visas — dela upp flödet';

// The full diff for "Visa alla ändringar": every line of both sides, each JSON-quoted.
function diffText(info) {
  const head = [
    'Mac Code — ändringar i skills/' + info.slug + '/SKILL.md',
    'Fil: ' + info.skillPath,
    '+ = ny rad, - = borttagen rad. Varje rad visas JSON-citerad.',
    ''
  ];
  return head.concat((info.ops || []).map((o) => o.t + ' ' + quoteForDisplay(o.l))).join('\n') + '\n';
}

// Writes the full diff to <userData>/flow-preview/<slug>-<stamp>.txt, keeps the newest
// KEEP_PREVIEWS files there, and returns the new file's path.
const KEEP_PREVIEWS = 5;
function writeDiffFile({ userData, slug, text, now = () => new Date() }) {
  if (!slugOk(slug)) throw new Error('ogiltigt flödesnamn');
  const dir = path.join(path.resolve(userData), 'flow-preview');
  fs.mkdirSync(dir, { recursive: true });
  const d = now();
  const pad = (x, k = 2) => String(x).padStart(k, '0');
  const st = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + pad(d.getMilliseconds(), 3);
  let p = null;
  for (let k = 1; k < 1000 && !p; k++) {
    const cand = path.join(dir, slug + '-' + st + '-' + k + '.txt');
    try { fs.writeFileSync(cand, text, { encoding: 'utf8', flag: 'wx' }); p = cand; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  if (!p) throw new Error('no free preview name');
  try {
    // Newest first by the stamp in the name (<slug>-<stamp>-<n>.txt); other files stay.
    const key = (f) => {
      const m = /-(\d{8}-\d{6}-\d{3})-(\d{1,3})\.txt$/.exec(f);
      return m ? m[1] + '-' + m[2].padStart(3, '0') : null;
    };
    const files = fs.readdirSync(dir).filter((f) => key(f)).sort((x, y) => (key(x) < key(y) ? 1 : key(x) > key(y) ? -1 : 0));
    for (const f of files.slice(KEEP_PREVIEWS)) {
      const fp = path.join(dir, f);
      if (fp !== p) { try { fs.unlinkSync(fp); } catch (_) {} }
    }
  } catch (_) {}
  return p;
}

// `@path` in a skill makes Claude Code include that file (R7 warning): @ followed by an
// absolute / drive / home / relative path anywhere, or a word path after a separator.
const AT_PATH_RE = /@(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])\S*|(?:^|[\s(\[])@[A-Za-z0-9_.-]+(?:[\\/]\S*|\.[A-Za-z0-9]{1,10}\b)/;
function hasAtInclude(text) { return splitLines(text).some((l) => AT_PATH_RE.test(l)); }

const STATE_WORDS = Object.freeze({
  none: 'ny',
  generated: 'genererad av Mac Code',
  edited: 'ÄNDRAD FÖR HAND',
  foreign: 'INTE skapad av Mac Code',
  linked: 'länkad'
});

// The native confirm's text for writeSkill. Every line taken from file content is
// JSON-quoted so control / invisible characters show as escapes, never as layout.
function skillConfirmText(info) {
  const rel = 'skills/' + info.slug + '/SKILL.md';
  const overwrite = info.skillState === 'edited' || info.skillState === 'foreign';
  const lines = [
    'Fil: ' + info.skillPath,
    'Nuvarande fil: ' + (STATE_WORDS[info.skillState] || info.skillState),
    'Rader: ' + info.lines + ' (+' + info.added + ' / −' + info.removed + ' mot nuvarande fil)'
  ];
  if (overwrite) lines.push('', 'Den nuvarande filen sparas som backup och skrivs över.');
  if (info.atInclude) lines.push('', 'VARNING: texten innehåller @sökväg — Claude läser in den filen när skillen används.');
  // Long lines are cut so they can't push the rest off the (non-scrolling) dialog; a cut
  // line, like more lines than fit, makes the dialog offer the full diff.
  // The Windows task dialog grows instead of scrolling, so line length, line count and the
  // whole text are capped; anything cut makes the dialog offer the full diff.
  let cut = false;
  const body = [];
  const side = (title, list, sign) => {
    if (!list.length) return;
    body.push('', title);
    for (const l of list.slice(0, PREVIEW_LINES)) {
      let q = quoteForDisplay(l);
      if (q.length > PREVIEW_LINE_CHARS) { q = q.slice(0, PREVIEW_LINE_CHARS) + '…'; cut = true; }
      body.push(sign + ' ' + q);
    }
    const more = list.length - PREVIEW_LINES;
    if (more > 0) body.push('  … och ' + more + ' till');
  };
  const addedLines = info.addedLines || [];
  const removedLines = info.removedLines || [];
  side('Nya rader:', addedLines, '+');
  side('Borttagna rader:', removedLines, '−');
  let bodyText = body.join('\n');
  if (bodyText.length > PREVIEW_TOTAL_CHARS) { bodyText = bodyText.slice(0, PREVIEW_TOTAL_CHARS) + '\n  …'; cut = true; }
  // More than the dialog shows → it offers the full diff (R7: nothing hidden). The notice
  // goes above the lines so it stays visible even if the bottom of the dialog is clipped.
  const truncated = cut || addedLines.length > PREVIEW_LINES || removedLines.length > PREVIEW_LINES;
  if (truncated) lines.push('', 'Alla ändringar syns inte här — välj "Visa alla ändringar" för att läsa hela diffen.');
  return {
    message: 'Skriv ' + rel + '?',
    detail: lines.join('\n') + (bodyText ? '\n' + bodyText : ''),
    button: overwrite ? 'Skriv över' : 'Skriv',
    truncated
  };
}

// Tokens of a hook command, quotes removed.
function commandTokens(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => (/^(["']).*\1$/.test(t) ? t.slice(1, -1) : t));
}
function baseName(tok) { const p = tok.split(/[\\/]/); return (p[p.length - 1] || '').toLowerCase(); }

function hintMatches(hint, command) {
  const toks = commandTokens(command);
  const i = toks.findIndex((t) => baseName(t) === hint.script.toLowerCase());
  if (i < 0) return false;
  return hint.arg == null ? true : toks[i + 1] === hint.arg;
}

// hooks: [{ event, matcher, command, enabled }] -> hookRef or null. Prefers an active
// hook on the hinted event, then any active one, then the disabled ones.
function resolveHint(hint, hooks) {
  const cands = hooks.filter((h) => h.type === 'command' && hintMatches(hint, h.command));
  const pick = cands.find((h) => h.enabled && h.event === hint.event) ||
    cands.find((h) => h.enabled) ||
    cands.find((h) => h.event === hint.event) ||
    cands[0];
  return pick ? { event: pick.event, matcher: pick.matcher || '', command: pick.command.trim() } : null;
}

// ---------------------------------------------------------------------------------
// confirm({ slug, skillPath, skillState, lines, added, removed, addedLines, removedLines,
//           ops, atInclude }) -> Promise<bool>
//   main shows skillConfirmText(info) in a native dialog; when it is truncated, main can
//   write diffText(info) with writeDiffFile() and open it.
// ---------------------------------------------------------------------------------
function createFlowStore({ root, userData, confirm, now = () => new Date(), claudeConfig } = {}) {
  if (!root || !userData) throw new Error('root and userData are required');
  root = path.resolve(root);
  const flowsDir = path.join(root, 'flows');
  const skillsDir = path.join(root, 'skills');
  const backupDir = path.join(root, 'backups', 'mac-code');
  const { backupFile } = createBackups(backupDir, now);
  const ask = typeof confirm === 'function' ? confirm : async () => false;
  const cfg = claudeConfig || createClaudeConfig({ root, userData, now });
  const backedUp = new Set();

  function flowFile(slug) { return slugOk(slug) ? childPath(flowsDir, slug, '.json') : null; }
  function skillDirOf(slug) { return slugOk(slug) ? childPath(skillsDir, slug) : null; }

  // -> { missing:true } | { error, rev? } | { raw, text, rev, flow }
  function readFlow(slug) {
    const p = flowFile(slug);
    let raw;
    try { raw = readCapped(p); } catch (err) {
      if (err.code === 'ENOENT') return { missing: true };
      return { error: errMsg(err) };
    }
    const rev = sha1(raw);
    let obj;
    try { obj = JSON.parse(stripBom(raw.toString('utf8'))); } catch (err) {
      return { error: 'flows/' + slug + '.json är inte giltig JSON: ' + errMsg(err), rev };
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) obj.slug = slug; // R15
    const v = validateFlow(obj);
    if (!v.ok) return { error: 'flows/' + slug + '.json: ' + v.error, rev };
    return { raw, rev, flow: v.flow };
  }

  // State of skills/<slug>/SKILL.md relative to a flow's `generated`.
  // -> { dir, file, state, text, rev, target }
  function skillInfo(slug, generated) {
    const dir = skillDirOf(slug);
    const file = path.join(dir, 'SKILL.md');
    const info = { dir, file, state: 'none', text: null, rev: null, target: null };
    let dst;
    try { dst = fs.lstatSync(dir); } catch (_) { return info; }
    const linkTarget = (p) => { try { return fs.realpathSync(p); } catch (_) { try { return fs.readlinkSync(p); } catch (__) { return null; } } };
    if (dst.isSymbolicLink()) return Object.assign(info, { state: 'linked', target: linkTarget(dir) });
    if (!dst.isDirectory()) return Object.assign(info, { state: 'foreign', notDir: true });
    let fst;
    try { fst = fs.lstatSync(file); } catch (_) { return info; }
    if (fst.isSymbolicLink()) return Object.assign(info, { state: 'linked', target: linkTarget(file) });
    if (!fst.isFile()) return Object.assign(info, { state: 'foreign', notDir: true });
    const raw = readCapped(file);
    info.rev = sha1(raw);
    info.text = raw.toString('utf8');
    if (!hasMarker(info.text, slug)) info.state = 'foreign';
    else info.state = generated && generated.sha1 === info.rev ? 'generated' : 'edited';
    return info;
  }

  function hooksForResolve() {
    let l;
    try { l = cfg.list(); } catch (_) { return []; }
    return (l.hooks || []).concat(l.disabled || []);
  }

  function resolvedDefault() {
    const flow = defaultOrchestrateFlow();
    const hooks = hooksForResolve();
    for (const n of flow.nodes) {
      const hints = DEFAULT_HOOK_HINTS[n.id] || [];
      for (const h of hints) {
        const ref = resolveHint(h, hooks);
        if (ref && !n.hooks.some((x) => x.event === ref.event && x.matcher === ref.matcher && x.command === ref.command)) n.hooks.push(ref);
      }
    }
    const v = validateFlow(flow);
    if (v.ok) return v.flow;
    // A user hook that does not pass validation is simply not attached.
    const plain = defaultOrchestrateFlow();
    return validateFlow(plain).flow;
  }

  function paths(slug) {
    return { flow: flowFile(slug), skill: path.join(skillDirOf(slug), 'SKILL.md') };
  }

  // ---- list ----
  function flowList() {
    let names;
    try { names = fs.readdirSync(flowsDir); } catch (_) { names = []; }
    const flows = [];
    for (const file of names.sort()) {
      if (!/\.json$/.test(file)) continue;
      const slug = file.slice(0, -5);
      if (!slugOk(slug)) continue;
      try { if (!fs.statSync(path.join(flowsDir, file)).isFile()) continue; } catch (_) { continue; }
      const r = readFlow(slug);
      if (r.missing) continue;
      const entry = { slug, name: slug, rev: r.rev || null, nodes: 0, skillState: 'none' };
      if (r.error) entry.error = r.error;
      else { entry.name = r.flow.name; entry.nodes = r.flow.nodes.length; }
      try { entry.skillState = skillInfo(slug, r.flow ? r.flow.generated : null).state; } catch (err) { entry.skillError = errMsg(err); }
      flows.push(entry);
    }
    return { ok: true, flows, hasOrchestrateFile: flows.some((f) => f.slug === DEFAULT_SLUG) };
  }

  // ---- get ----
  function flowGet({ slug } = {}) {
    if (!slugOk(slug)) return fail('ogiltigt flödesnamn');
    const r = readFlow(slug);
    if (r.missing) {
      if (slug !== DEFAULT_SLUG) return fail('flödet finns inte', { notFound: true });
      const flow = resolvedDefault();
      let skillState = 'none';
      try { skillState = skillInfo(slug, null).state; } catch (_) {}
      return { ok: true, flow, rev: null, isDefault: true, skillState, paths: paths(slug) };
    }
    if (r.error) return fail(r.error, { rev: r.rev || null });
    let skillState = 'none';
    try { skillState = skillInfo(slug, r.flow.generated).state; } catch (_) {}
    return { ok: true, flow: r.flow, rev: r.rev, skillState, paths: paths(slug) };
  }

  function writeFlowFile(slug, flow) {
    const text = JSON.stringify(flow, null, 2) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) throw new Error('flödet är för stort');
    fs.mkdirSync(flowsDir, { recursive: true });
    atomicWriteText(flowFile(slug), text);
    return sha1(text);
  }

  // ---- save ----
  // rev null = create (refused if the file exists). `generated` is owned by main (R5):
  // the incoming value is ignored, the one on disk kept.
  function flowSave({ slug, flow, rev } = {}) {
    if (!slugOk(slug)) return fail('ogiltigt flödesnamn', { invalid: true });
    const input = flow && typeof flow === 'object' && !Array.isArray(flow) ? Object.assign({}, flow, { slug, generated: null }) : flow;
    const v = validateFlow(input);
    if (!v.ok) return fail(v.error, { invalid: true, field: v.field });
    const next = v.flow;
    const p = flowFile(slug);
    try {
      if (rev == null) {
        if (fs.existsSync(p)) return fail('Det finns redan ett flöde som heter ' + slug, { conflict: true, exists: true });
        if (slug !== DEFAULT_SLUG) {
          const s = skillInfo(slug, null);
          if (s.state === 'foreign' || s.state === 'linked') {
            return fail('Det finns redan en skill som heter ' + slug + ' som inte skapades av Mac Code', { exists: true });
          }
        }
        next.generated = null;
        return { ok: true, rev: writeFlowFile(slug, next) };
      }
      const cur = readFlow(slug);
      if (cur.missing) return fail(CHANGED, { conflict: true });
      if (cur.rev !== rev) return fail(CHANGED, { conflict: true });
      next.generated = cur.flow ? cur.flow.generated : null;
      if (!backedUp.has(slug)) {
        backupFile(p, 'flow-' + slug + '.json');
        backedUp.add(slug);
      }
      return { ok: true, rev: writeFlowFile(slug, next) };
    } catch (err) { return fail(errMsg(err)); }
  }

  // ---- delete (only the flow file; the skill stays) ----
  function flowDelete({ slug, rev } = {}) {
    if (!slugOk(slug)) return fail('ogiltigt flödesnamn');
    const p = flowFile(slug);
    try {
      let raw;
      try { raw = readCapped(p); } catch (err) {
        if (err.code === 'ENOENT') return fail('flödet finns inte', { conflict: true });
        throw err;
      }
      if (sha1(raw) !== rev) return fail(CHANGED, { conflict: true });
      backupFile(p, 'flow-' + slug + '.json');
      fs.unlinkSync(p);
      backedUp.delete(slug);
      return { ok: true };
    } catch (err) { return fail(errMsg(err)); }
  }

  function compileChecked(flow) {
    const markdown = compileFlow(flow);
    const exec = execError(markdown);
    if (exec) throw new Error(exec);
    return markdown;
  }

  // ---- preview (the SAVED flow file; the built-in default when orchestrate has none) ----
  function flowPreview({ slug } = {}) {
    if (!slugOk(slug)) return fail('ogiltigt flödesnamn');
    try {
      const r = readFlow(slug);
      let flow;
      let isDefault = false;
      if (r.missing) {
        if (slug !== DEFAULT_SLUG) return fail('flödet finns inte', { notFound: true });
        flow = resolvedDefault();
        isDefault = true;
      } else if (r.error) return fail(r.error);
      else flow = r.flow;
      const markdown = compileChecked(flow);
      const s = skillInfo(slug, flow.generated);
      const d = lineDiff(s.text, markdown);
      const res = {
        ok: true, markdown, skillState: s.state, skillPath: s.file,
        lines: splitLines(markdown).length,
        added: d.tooLarge ? null : d.added, removed: d.tooLarge ? null : d.removed, tooLarge: !!d.tooLarge,
        rev: r.rev || null, missingDescription: !flow.description,
        atInclude: hasAtInclude(markdown)
      };
      if (isDefault) res.isDefault = true;
      if (s.state === 'linked') res.linkedTarget = s.target;
      return res;
    } catch (err) { return fail(errMsg(err)); }
  }

  // ---- write SKILL.md (R5) ----
  async function flowWriteSkill({ slug, rev } = {}) {
    if (!slugOk(slug)) return fail('ogiltigt flödesnamn');
    if (typeof rev !== 'string') return fail('flödet är inte sparat än');
    try {
      const r = readFlow(slug);
      if (r.missing) return fail(CHANGED, { conflict: true });
      if (r.error) return fail(r.error);
      if (r.rev !== rev) return fail(CHANGED, { conflict: true });
      if (!r.flow.description) return fail('Beskrivning saknas — Claude använder den för att veta när skillen ska köras');
      const markdown = compileChecked(r.flow);
      const s = skillInfo(slug, r.flow.generated);
      if (s.state === 'linked') return fail('Skillen är länkad till ' + (s.target || '?') + ' — skriv inte där', { linked: true });
      if (s.notDir) return fail('skills/' + slug + ' är inte en skill-mapp');
      const d = lineDiff(s.text, markdown);
      if (d.tooLarge) return fail(TOO_LARGE, { tooLarge: true });
      const info = {
        slug, skillPath: s.file, skillState: s.state, lines: splitLines(markdown).length,
        added: d.added, removed: d.removed, addedLines: d.addedLines, removedLines: d.removedLines,
        ops: d.ops, atInclude: hasAtInclude(markdown)
      };
      if (!(await ask(info))) return fail('canceled', { canceled: true });

      // Re-check everything after the dialog: the flow file, the skill file, the links.
      const again = readFlow(slug);
      if (again.missing || again.error || again.rev !== rev) return fail(CHANGED, { conflict: true });
      const s2 = skillInfo(slug, again.flow.generated);
      if (s2.state === 'linked') return fail('Skillen är länkad till ' + (s2.target || '?') + ' — skriv inte där', { linked: true });
      if (s2.notDir) return fail('skills/' + slug + ' är inte en skill-mapp');
      if (s2.rev !== s.rev) return fail('SKILL.md ändrades medan dialogen var öppen — försök igen', { conflict: true, skillChanged: true });

      fs.mkdirSync(skillsDir, { recursive: true });
      try { fs.mkdirSync(s2.dir); } catch (err) { if (err.code !== 'EEXIST') throw err; }
      // Last link check right before the write (atomicWriteText would follow a link).
      if (fs.lstatSync(s2.dir).isSymbolicLink()) return fail('Skillen är länkad — skriv inte där', { linked: true });
      try { if (fs.lstatSync(s2.file).isSymbolicLink()) return fail('Skillen är länkad — skriv inte där', { linked: true }); } catch (_) {}
      if (s2.text != null) backupFile(s2.file, 'skill-' + slug + '-SKILL.md');
      atomicWriteText(s2.file, markdown);
      const hash = sha1(markdown);
      const at = now().toISOString();

      // Read-modify-write the flow file: only `generated` changes.
      const flow = Object.assign({}, again.flow, { generated: { sha1: hash, at } });
      if (!backedUp.has(slug)) {
        backupFile(flowFile(slug), 'flow-' + slug + '.json');
        backedUp.add(slug);
      }
      const newRev = writeFlowFile(slug, flow);
      return { ok: true, sha1: hash, rev: newRev, at, skillPath: s2.file };
    } catch (err) { return fail(errMsg(err)); }
  }

  return {
    paths: { root, flowsDir, skillsDir, backupDir },
    flowList, flowGet, flowSave, flowDelete, flowPreview, flowWriteSkill
  };
}

module.exports = {
  createFlowStore, skillConfirmText, diffText, writeDiffFile, hasMarker, lineDiff, resolveHint, hasAtInclude,
  PREVIEW_LINES, KEEP_PREVIEWS, TOO_LARGE
};
