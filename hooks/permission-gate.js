// PreToolUse hook: blocks the Claude CLI until the Mac Code UI approves the call.
//
// The CLI runs this once per tool call, feeds the hook payload on stdin, and waits
// for the process to exit before acting on the printed decision. We forward the
// payload to the gate server main.js runs on 127.0.0.1 and print whatever the user
// (or a stored always-allow rule) decided.
//
// Env contract, set by main.js when it spawns the chat process:
//   MAC_CODE_GATE_URL    http://127.0.0.1:<port>/permission
//   MAC_CODE_GATE_TOKEN  random per-launch token, checked by the server
//   MAC_CODE_CHAT_ID     which chat pane to surface the request in
//
// Printing nothing leaves the CLI's own default in charge, which is to deny. That
// is the fail-safe we want if the app has gone away.

const http = require('http');

const GATE_URL = process.env.MAC_CODE_GATE_URL;
const GATE_TOKEN = process.env.MAC_CODE_GATE_TOKEN;
const CHAT_ID = process.env.MAC_CODE_CHAT_ID;

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || ''
    }
  }));
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function ask(payload) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(GATE_URL); } catch { return resolve(null); }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-mac-code-token': GATE_TOKEN || ''
      }
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
    });
    // No client-side timeout: the user may take as long as they like. The CLI's own
    // hook timeout is the ceiling, and if it fires the tool call is denied anyway.
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

(async () => {
  const raw = await readStdin();
  let event;
  try { event = JSON.parse(raw || '{}'); } catch { event = {}; }

  if (!GATE_URL) {
    // Not launched by Mac Code — stay out of the way and let normal rules apply.
    emit('ask', 'Mac Code permission gate not configured');
    return;
  }

  const answer = await ask({ token: GATE_TOKEN, chatId: CHAT_ID, event });
  if (!answer || !answer.decision) {
    emit('deny', 'Mac Code permission gate unreachable — denied by default');
    return;
  }
  emit(answer.decision, answer.reason);
})();
