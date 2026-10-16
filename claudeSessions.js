// Matches a running Claude CLI to the terminal pane it was started in, from the
// ~/.claude/sessions/<pid>.json files the CLI keeps while it runs. Pure: no I/O —
// main.js reads the files and the process snapshot and feeds them in.
//
// The session file format is undocumented, so every field is checked and anything
// unexpected counts as "no match" rather than a guess.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROC_NAMES = new Set(['claude', 'claude.exe', 'node', 'node.exe', 'bun', 'bun.exe']);
const START_SLACK_MS = 2000;   // startedAt may land a bit before the renderer saw the command
const CREATE_SLACK_MS = 1500;  // process creation vs. the file's procStart
const STARTUP_MAX_MS = 5000;   // startedAt is stamped after CLI startup, seen ~1-2 s after creation
const MAX_HOPS = 4;            // shell -> claude, or shell -> cmd -> node via claude.cmd
const FILETIME_EPOCH_MS = 11644473600000n; // 1601-01-01 to 1970-01-01

function normCwd(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

// FILETIME (100 ns ticks since 1601, as a decimal string or number) to epoch ms.
function filetimeToMs(ft) {
  if (typeof ft !== 'string' && typeof ft !== 'number') return null;
  const s = String(ft).trim();
  if (!/^\d{1,20}$/.test(s)) return null;
  try {
    const ms = BigInt(s) / 10000n - FILETIME_EPOCH_MS;
    return ms > 0n ? Number(ms) : null;
  } catch (_) { return null; }
}

function parseSessionFile(raw) {
  let j;
  try { j = JSON.parse(raw); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  if (!Number.isInteger(j.pid) || j.pid <= 0) return null;
  if (typeof j.sessionId !== 'string' || !UUID_RE.test(j.sessionId)) return null;
  if (typeof j.cwd !== 'string' || !j.cwd) return null;
  return {
    pid: j.pid,
    sessionId: j.sessionId,
    cwd: j.cwd,
    kind: typeof j.kind === 'string' ? j.kind : null,
    startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null,
    procStart: typeof j.procStart === 'string' || typeof j.procStart === 'number' ? String(j.procStart) : null
  };
}

// Interactive sessions in the pane's folder that started with (or after) this run.
function filterCandidates(sessions, { sinceMs, cwd, claimedPids }) {
  const want = normCwd(cwd);
  if (!want || !Number.isFinite(sinceMs)) return [];
  return sessions.filter(s => s && s.kind === 'interactive'
    && !(claimedPids && claimedPids.has(s.pid))
    && s.startedAt != null && s.startedAt >= sinceMs - START_SLACK_MS
    && normCwd(s.cwd) === want);
}

// Lines of "pid,ppid,filetime,name" (name last: it is the only free-text field).
function parseProcessSnapshot(text) {
  const procs = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+),(\d+),(\d*),(.*)$/);
    if (!m) continue;
    procs.set(+m[1], { pid: +m[1], ppid: +m[2], createdMs: filetimeToMs(m[3]), name: m[4].trim().toLowerCase() });
  }
  return procs;
}

function hopsToShell(procs, pid, shellPid) {
  let cur = procs.get(pid);
  for (let hops = 1; cur && hops <= MAX_HOPS; hops++) {
    if (cur.ppid === shellPid) return hops;
    if (cur.ppid === cur.pid) return null;
    cur = procs.get(cur.ppid);
  }
  return null;
}

// The candidate whose process descends from the pane's shell. The creation time check
// rejects a stale file whose pid has since been reused; the fewest-hops pick rejects a
// claude that another claude started (its own tools run under the outer one).
function pickByAncestry(candidates, procs, shellPid) {
  let best = null, bestHops = Infinity, tie = false;
  for (const c of candidates) {
    const p = procs.get(c.pid);
    if (!p || !PROC_NAMES.has(p.name) || p.createdMs == null) continue;
    const ps = filetimeToMs(c.procStart);
    const timeOk = (ps != null && Math.abs(p.createdMs - ps) <= CREATE_SLACK_MS)
      || (c.startedAt != null && p.createdMs >= c.startedAt - STARTUP_MAX_MS
        && p.createdMs <= c.startedAt + CREATE_SLACK_MS);
    if (!timeOk) continue;
    const hops = hopsToShell(procs, c.pid, shellPid);
    if (hops == null) continue;
    if (hops < bestHops) { best = c; bestHops = hops; tie = false; }
    else if (hops === bestHops) tie = true;
  }
  return tie ? null : best;
}

// When the CLI last finished a turn, from the transcript's JSONL lines. Scans from the
// end for the newest decisive entry: an assistant entry that ended the turn (end_turn,
// stop_sequence, refusal, API error) or an Esc interrupt means the turn is over (endedAt
// = that entry's time); any other assistant entry (tool_use, still streaming), a tool
// result or a real user prompt means a turn is running. Turns can also start from meta
// entries (agent hand-backs, stop-hook feedback), ! bash mode or slash commands; those
// are skipped, and the assistant entry they lead to decides.
const TURN_END_REASONS = new Set(['end_turn', 'stop_sequence', 'refusal']);
const NON_PROMPT_RE = /^\s*<(command-name|command-message|local-command-|bash-input|bash-stdout|bash-stderr|system-reminder)/;

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

function lastTurnEnd(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    const m = o.message;
    const ts = Date.parse(o.timestamp);
    const endedAt = Number.isFinite(ts) ? ts : null;
    if (o.type === 'assistant') {
      if (o.isApiErrorMessage === true || (m && TURN_END_REASONS.has(m.stop_reason))) return { endedAt, active: false };
      return { endedAt: null, active: true };
    } else if (o.type === 'user' && m) {
      if (o.isMeta) continue;
      const text = userText(m.content);
      if (/^\s*\[Request interrupted by user/.test(text)) return { endedAt, active: false };
      if (Array.isArray(m.content) && m.content.length && m.content.every(b => b && b.type === 'tool_result')) return { endedAt: null, active: true };
      if (NON_PROMPT_RE.test(text)) continue;
      return { endedAt: null, active: true };
    }
  }
  return { endedAt: null, active: false };
}

const MAX_FAILS = 5;

// Per-pty bookkeeping for main's claude:paneSession: which Claude process a pane has
// been matched to, and how many snapshot lookups failed for the current run. Any
// candidate goes through the ancestry check, even a lone one: a lone file can be another
// tab's Claude whose own pane hasn't polled yet, or one in an external terminal.
class PaneSessionTracker {
  constructor() {
    this.cache = new Map();  // ptyId -> { claudePid, procStart, sinceMs }
    this.fails = new Map();  // ptyId -> { sinceMs, count }
  }

  // The match for this run, or null. A match from an earlier run is dropped.
  cached(ptyId, sinceMs) {
    const c = this.cache.get(ptyId);
    if (c && c.sinceMs !== sinceMs) { this.cache.delete(ptyId); return null; }
    return c || null;
  }

  // The cached process's freshly read session file, or null once it has gone or its
  // pid now belongs to another process. The id may change in place (/clear, /resume).
  verifyCached(ptyId, file) {
    const c = this.cache.get(ptyId);
    if (c && file && file.pid === c.claudePid && file.procStart === c.procStart) return file;
    this.cache.delete(ptyId);
    return null;
  }

  givenUp(ptyId, sinceMs) {
    const f = this.fails.get(ptyId);
    return !!f && f.sinceMs === sinceMs && f.count >= MAX_FAILS;
  }

  candidates(ptyId, sessions, { sinceMs, cwd }) {
    const claimedPids = new Set();
    for (const [id, c] of this.cache) if (id !== ptyId) claimedPids.add(c.claudePid);
    return filterCandidates(sessions, { sinceMs, cwd, claimedPids });
  }

  // Settles a lookup: procs is the process snapshot (null when it failed).
  resolve(ptyId, candidates, procs, { sinceMs, shellPid }) {
    const pick = procs ? pickByAncestry(candidates, procs, shellPid) : null;
    if (!pick) {
      const f = this.fails.get(ptyId);
      this.fails.set(ptyId, { sinceMs, count: f && f.sinceMs === sinceMs ? f.count + 1 : 1 });
      return null;
    }
    this.cache.set(ptyId, { claudePid: pick.pid, procStart: pick.procStart, sinceMs });
    this.fails.delete(ptyId);
    return pick;
  }

  forget(ptyId) {
    this.cache.delete(ptyId);
    this.fails.delete(ptyId);
  }
}

module.exports = {
  normCwd, filetimeToMs, parseSessionFile, filterCandidates, parseProcessSnapshot, pickByAncestry,
  lastTurnEnd, PaneSessionTracker, MAX_FAILS, UUID_RE
};
