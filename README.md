# Mac Code

Modern PowerShell wrapper for Windows. Electron + xterm.js + node-pty. Frameless Windows 11 dark style with tabs, an Explorer, a Monaco editor, and native Claude chat panes.

## Features

### Terminal
- Real PowerShell 7 (`pwsh.exe`) per tab via node-pty (falls back to `powershell.exe`)
- xterm.js with Windows Terminal default color scheme
- Split panes (horizontal / vertical), drag-to-resize, drag-to-reorder tabs — panes grow to fill the window
- Running Claude in a terminal pane gets its own composer band below that pane, so both halves of a split can drive Claude at once
- Native Notepad-style undo/redo in the composers (`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`), chunk-level `Ctrl+Z` undo in the terminal

### Claude chat panes
A chat tab drives the Claude CLI directly instead of running it inside a terminal:
message stream, collapsible tool cards, inline diffs for edits, and an approval card
for every tool call that needs permission.

- Composer with image paste/drop, a `/` command palette, model picker, and a context meter
- **Your own commands**: `/cp` for "Commit and push", `/pr` for a whole review-then-PR
  instruction — see below
- **Plan usage**: the 5-hour and weekly windows `/usage` prints in the CLI, in the
  composer footer and the status bar, with reset times on hover. Read from the same
  subscription endpoint the CLI uses, so it needs a Claude subscription login —
  API-key, Bedrock and Vertex setups have no such window and the meter stays hidden.
- **Model picker**: the four CLI aliases (always the newest of each family) plus the
  older versions your account can use — Opus 4.8, Sonnet 4.6, … — listed from
  `/v1/models` rather than hardcoded. A **1M context** toggle composes with any of them
  (every family except Haiku), and passes the CLI's `[1m]` alias suffix.
- Streaming text is revealed per animation frame, paced to how fast the CLI hands over
  chunks, instead of a lump landing per delta
- **Terminal drawer** (`Ctrl+\``): a real shell in the pane's folder, for the things a
  chat can't do — interactive prompts, watching a build, `claude mcp login`. Resizable,
  survives `exit` (the chat tab stays open and the next open starts a fresh shell), and
  it can `cd` away without moving the chat's own folder.
- **`/mcp`**: manage MCP servers for the folder — status per server, login/logout,
  details, remove, and add (HTTP/SSE/stdio, local/project/user scope)
- Approve with **Allow once**, **Always allow &lt;command&gt;** (for the rest of the pane), or **Deny**
- Switching model relaunches the CLI with `--resume`, so the conversation carries over
  (skipped before the first message, when there is no transcript to resume yet)
- Sessions can be saved to the library and resumed later as a chat pane or in a terminal

#### Your own commands

A command is a shortcut for message text you send often. `/commands` in any Claude
composer — a chat pane or a hybrid terminal pane — opens the editor; add a name and the
text it stands for, and it shows up at the top of the `/` palette in every pane.

| In the palette | Does |
|---|---|
| `Enter` or click | Sends the command's text |
| `Tab` | Puts the text in the composer to edit first |

Anything typed after the name is appended — `/cp the drawer fix` sends
"Commit and push the drawer fix". Put `$ARGS` in the text to place it yourself instead:
`Fix $ARGS and add a test for it`. A command with `$ARGS` never sends on its own — it
fills the composer with its name and waits for the rest of the line.

These are Mac Code's own, not the CLI's: a composer expands one into plain text before
anything is sent, so nothing has to be written into `.claude/commands`, and the CLI's own
`/`-commands keep working next to them (they are listed in the same palette, below yours).
The list is per machine, kept in the app's local storage.

#### Permission modes

| Mode | Runs without asking |
|---|---|
| **Ask** | Read-only tools only (`Read`, `Glob`, `Grep`, `WebSearch`, …) |
| **Auto (local rules)** | Read-only tools, file edits, and shell commands on a safe allowlist |
| **Accept edits** | Read-only tools and file edits |
| **Bypass** | Everything |

A new pane starts in the mode your CLI is set to (`permissions.defaultMode` in
`~/.claude/settings.json`), mapped to the nearest mode above. Pick a mode and then
**Use \<mode\> for new panes** from the same menu to override that per machine.

> **Auto here is not the CLI's auto mode.** The CLI's auto mode runs a second model —
> a classifier — over each action, with a documented block list (`curl | bash`,
> force push, `terraform destroy`, secret exfiltration, …). That classifier does not
> grant approvals in the print-mode session Mac Code drives: with
> `--permission-mode auto` and no `--permission-prompt-tool`, tool calls are still
> denied with "This command requires approval". So Mac Code decides locally instead,
> from a static allowlist. Same intent, different mechanism, and no classifier —
> judge it on the rules below, not on the CLI's docs.

**Auto** allows commands that inspect state or run the project's own checks —
`git status/diff/log/show/branch`, `npm test`, `npm run …`, `ls`, `cat`, `node`,
`pytest`, and similar. It still asks for anything that writes, deletes, or reaches the
network: `git push/reset/clean/checkout`, `npm install/publish`, `rm`, `mv`, `curl`,
`wget`, `ssh`, `sudo`, process kills, output redirection (`>`, `>>`), and piping into a
shell. Every segment of a chained command (`&&`, `||`, `;`, `|`) has to clear the bar on
its own, and a risky token anywhere in the line forces a prompt regardless of the
command's head — so an allowlisted head cannot smuggle something through a pipe.

### Chrome
- Frameless window, custom titlebar with min/max/close
- Explorer (260px) with root folder header, entry count, and indent guides
- Agents panel (300px) with per-agent context meters, hand-off, and save
- Saved sessions list with **Clear old** — drops entries whose transcript was last
  active over a week ago, plus any whose transcript is gone (those can't be resumed;
  they show dimmed with a struck-through Resume). Right-click it for 1 day / 1 week /
  1 month, or to clear the whole library. Hover a row to see when it was last active —
  the name shows when it was *saved*, which can be much earlier.
- Status bar: cwd, tab count, shell, and live agent state
- Cascadia Code font (bundled), Consolas fallback

## Keyboard

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New shell tab |
| `Ctrl+Shift+L` | New Claude chat tab |
| `Ctrl+Shift+W` | Close pane, or tab if it is the last pane |
| `Ctrl+Shift+R` / `Ctrl+Shift+D` | Split right / split down |
| `Ctrl+B` / `Ctrl+Shift+B` | Toggle Explorer / Agents panel |
| `F2` | Rename tab |
| `Ctrl+\`` | Toggle a chat pane's terminal drawer |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` | Undo / redo — native in a composer (like Notepad), chunk-level undo in the terminal |
| `Enter` / `Shift+Enter` | Send / newline (composer) |
| `Ctrl+Enter` | Allow the newest pending permission request |
| `Esc` | Interrupt the current turn (composer) |

Right-click the `+` button for the full new-tab menu; right-click a folder in the
Explorer to open a shell, a Claude chat, or Copilot there.

## Install

```powershell
npm install
```

> `node-pty` builds a native module. Needs Visual Studio Build Tools and a matching Python on first install.
> If install fails, run `npm install --build-from-source` after installing windows-build-tools.

Claude chat panes need the `claude` CLI on `PATH` (or at `~\.local\bin\claude.exe`).

## Run

```powershell
npm start
```

## Build installer (NSIS, x64)

```powershell
npm run build
```

Output in `dist/`.

## Project layout

```
main.js                   Electron main — pty spawn, chat processes, permission gate, window mgmt
preload.js                contextBridge IPC surface
renderer.html             UI shell + all styling
renderer.js               tabs, panes, Explorer, agents panel, session persistence
chatView.js               Claude chat surface — stream rendering, tool cards, composer
hooks/permission-gate.js  PreToolUse hook: blocks the CLI until the UI approves a tool call
package.json              deps + electron-builder config
```

## How chat panes work

Each pane runs one long-lived CLI process:

```
claude -p --input-format stream-json --output-format stream-json
       --verbose --include-partial-messages --settings <hook config>
```

User messages go in as JSON lines on stdin; agent events come back on stdout. Text is
rendered from `stream_event` deltas so it appears as it is generated, then reconciled
against the buffered `assistant` event, which is also where tool calls come from.

**Permissions.** Print mode has no interactive prompt — a tool needing approval is
auto-denied. So the pane installs a `PreToolUse` hook that posts the pending call to a
loopback HTTP server in the main process and blocks until the renderer answers. The
server binds `127.0.0.1` only and checks a per-launch random token; if it is
unreachable the hook denies, so failure is fail-closed. Read-only tools are
auto-allowed without prompting, since the hook fires for every call.

Note the CLI's own workspace boundary still applies: a hook `allow` does not let the
agent write outside the directory the pane was started in.

**A cleaner mechanism exists.** `--permission-prompt-tool` is the documented way for a
`-p` run to ask an external approver, and CLI 2.1.233 still accepts it even though
`--help` no longer lists it. It takes an MCP tool name, so using it would mean Mac Code
exposing a small MCP server instead of a hook — and would let the CLI's own auto-mode
classifier run, with Mac Code prompting only on its blocks. Worth migrating to; the
hook is what's shipping today because it is verified working.

## Managing MCP servers

`/mcp` in a chat pane's composer opens a panel over the transcript, in two sections.

**Reachable from this folder** — live health from `claude mcp list`: connected, needs
authentication, failed (with the error), or pending approval. Where the pane's own CLI
session disagrees with that check, the row also carries a badge (`disabled here`,
`not in this pane` for a server added after the pane started), taken from the session's
`init` event. That is the authoritative answer to "can the agent actually use this?".

**Configured for other folders** — every server in the CLI's config that this folder
can't reach, with the folder that owns it. This exists because **`claude mcp add`
defaults to `local` scope, which is keyed to the exact directory it ran in and is not
inherited by subdirectories**: servers added in `C:\dev` are invisible from
`C:\dev\my-project`, which looks like they vanished. Two actions per row — *Copy here*
(local scope, this folder) and *Copy to all projects* (user scope, everywhere) — both
via `claude mcp add-json`. Or just open a chat pane in the owning folder and use them
there; nothing needs copying for that.

Every write shells out to `claude mcp …` rather than editing `~/.claude.json`. That file
is the CLI's own live state — startup counters, per-project history, ~100KB of it — so
writing to it from another process could lose data the CLI wrote concurrently. The CLI
owns its config; Mac Code only *reads* it, to find out which folder owns which server.

| Action | Runs |
|---|---|
| Add | `claude mcp add --scope <local\|project\|user> [--transport http\|sse] …` |
| Copy here / Copy to all projects | `claude mcp add-json --scope <local\|user> <name> <config>` |
| Remove | `claude mcp remove <name>` (asks for confirmation first) |
| Logout | `claude mcp logout <name>` |
| Details | `claude mcp get <name>` |
| Login | `claude mcp login <name>` **in the terminal drawer** |

Login goes to the drawer because it's an interactive OAuth flow — it needs a real pty
for the browser handoff and any prompt, which a captured subprocess can't give it.

MCP servers attach when the CLI process starts, so adding or removing one takes effect
after the pane restarts (switch model, or close and reopen the tab). The panel says so
rather than letting you wonder why a new server isn't there yet.

## IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `terminal:create` | invoke | Spawn pty, returns `{ id, shell, cwd }` |
| `terminal:input` / `terminal:resize` / `terminal:kill` | send | Drive the pty |
| `terminal:data` / `terminal:exit` | on | pty output / exit |
| `chat:start` | invoke | Launch a Claude CLI process for a pane |
| `chat:send` | invoke | Write a user message (content blocks) to stdin |
| `chat:interrupt` | invoke | Deny anything pending and stop the turn |
| `chat:setPermissionMode` | invoke | `default` / `auto` / `acceptEdits` / `bypassPermissions` for that pane |
| `chat:saveAttachment` | invoke | Persist a pasted image, returns its path |
| `chat:stop` | send | Kill the pane's process |
| `chat:permission-response` | send | Answer a pending approval request |
| `chat:event` / `chat:stderr` / `chat:exit` | on | Parsed stream events, stderr, exit |
| `chat:permission-request` | on | A tool call is waiting on the user |
| `claude:usage` / `copilot:usage` | invoke | Read context usage from CLI session logs |
| `claude:handoff` | invoke | Write a Claude → Copilot handoff brief |
| `fs:list` / `fs:home` / `fs:parent` | invoke | Explorer directory listing |
| `file:read` / `file:write` / `file:openExternal` | invoke | Editor + Explorer file access |
| `session:load` / `session:save` | invoke/send | Restore and persist open tabs |
| `session:ages` | invoke | Transcript mtime per saved session, for **Clear old** |
| `claude:defaultPermissionMode` | invoke | Reads `permissions.defaultMode` from the CLI's settings |
| `mcp:list` / `mcp:get` / `mcp:add` / `mcp:addJson` / `mcp:remove` / `mcp:logout` | invoke | Wrap `claude mcp …` for the `/mcp` panel |
| `mcp:configured` | invoke | Read-only scan of `~/.claude.json` + `.mcp.json` for which folder owns which server |
| `window:minimize` / `window:maximize` / `window:close` | send | Frame controls |
