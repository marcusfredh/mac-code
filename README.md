# Mac Code

Modern PowerShell wrapper for Windows. Electron + xterm.js + node-pty. Frameless Windows 11 dark style with tabs.

## Features

- Real PowerShell 7 (`pwsh.exe`) per tab via node-pty (falls back to `powershell.exe`)
- xterm.js with Windows Terminal default color scheme
- Frameless window, custom titlebar with min/max/close
- Tab bar with shell icon, title, close button, `+` for new tab
- Active tab gets a 2px `#007acc` bottom border
- Cascadia Code font (bundled), Consolas fallback
- Status bar: cwd, tab count, "Claude Code ready"
- Keyboard: `Ctrl+Shift+T` new tab, `Ctrl+Shift+W` close tab

## Install

```powershell
npm install
```

> `node-pty` builds a native module. Needs Visual Studio Build Tools and a matching Python on first install.
> If install fails, run `npm install --build-from-source` after installing windows-build-tools.

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
main.js          Electron main process — pty spawn, window mgmt
preload.js       contextBridge IPC surface
renderer.html    UI shell (titlebar, tabs, terminal mount, statusbar)
renderer.js      xterm.js init, tab logic, IPC wiring
package.json     deps + electron-builder config
```

## IPC channels

| Channel | Direction | Purpose |
|---|---|---|
| `terminal:create` | invoke | Spawn pty, returns `{ id, shell, cwd }` |
| `terminal:input` | send | Write keystrokes to pty |
| `terminal:resize` | send | Resize pty (cols, rows) |
| `terminal:kill` | send | Kill pty |
| `terminal:data` | on | Stream pty stdout/stderr to renderer |
| `terminal:exit` | on | pty exited |
| `window:minimize` / `window:maximize` / `window:close` | send | Frame controls |
