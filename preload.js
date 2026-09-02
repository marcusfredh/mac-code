const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('term', {
  create: (opts) => ipcRenderer.invoke('terminal:create', opts),
  input: (id, data) => ipcRenderer.send('terminal:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('terminal:kill', id),
  onData: (callback) => {
    const listener = (_event, id, data) => callback(id, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onExit: (callback) => {
    const listener = (_event, id, code) => callback(id, code);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  }
});

contextBridge.exposeInMainWorld('win', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  }
});

contextBridge.exposeInMainWorld('fs', {
  list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
  home: () => ipcRenderer.invoke('fs:home'),
  parent: (p) => ipcRenderer.invoke('fs:parent', p)
});

contextBridge.exposeInMainWorld('claudeApi', {
  usage: (cwd) => ipcRenderer.invoke('claude:usage', cwd),
  limits: (force) => ipcRenderer.invoke('claude:limits', { force: !!force }),
  models: (force) => ipcRenderer.invoke('claude:models', { force: !!force }),
  handoff: (args) => ipcRenderer.invoke('claude:handoff', args),
  defaultPermissionMode: () => ipcRenderer.invoke('claude:defaultPermissionMode'),
  defaultModel: () => ipcRenderer.invoke('claude:defaultModel')
});

contextBridge.exposeInMainWorld('copilotApi', {
  usage: (cwd) => ipcRenderer.invoke('copilot:usage', cwd)
});

contextBridge.exposeInMainWorld('chatApi', {
  start:             (opts)  => ipcRenderer.invoke('chat:start', opts),
  send:              (args)  => ipcRenderer.invoke('chat:send', args),
  interrupt:         (args)  => ipcRenderer.invoke('chat:interrupt', args),
  setPermissionMode: (args)  => ipcRenderer.invoke('chat:setPermissionMode', args),
  saveAttachment:    (args)  => ipcRenderer.invoke('chat:saveAttachment', args),
  stop:              (id)    => ipcRenderer.send('chat:stop', id),
  respondPermission: (args)  => ipcRenderer.send('chat:permission-response', args),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
  onStderr: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:stderr', listener);
    return () => ipcRenderer.removeListener('chat:stderr', listener);
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:exit', listener);
    return () => ipcRenderer.removeListener('chat:exit', listener);
  },
  onPermissionRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:permission-request', listener);
    return () => ipcRenderer.removeListener('chat:permission-request', listener);
  }
});

contextBridge.exposeInMainWorld('mcpApi', {
  list:       (args) => ipcRenderer.invoke('mcp:list', args),
  get:        (args) => ipcRenderer.invoke('mcp:get', args),
  add:        (args) => ipcRenderer.invoke('mcp:add', args),
  addJson:    (args) => ipcRenderer.invoke('mcp:addJson', args),
  configured: (args) => ipcRenderer.invoke('mcp:configured', args),
  remove:     (args) => ipcRenderer.invoke('mcp:remove', args),
  logout:     (args) => ipcRenderer.invoke('mcp:logout', args)
});

contextBridge.exposeInMainWorld('gitApi', {
  branches:   (cwd)         => ipcRenderer.invoke('git:branches', cwd),
  switch:     (cwd, branch) => ipcRenderer.invoke('git:switch', { cwd, branch }),
  updateMain: (cwd)         => ipcRenderer.invoke('git:updateMain', cwd)
});

contextBridge.exposeInMainWorld('fileApi', {
  read:         (p)          => ipcRenderer.invoke('file:read', p),
  write:        (p, content) => ipcRenderer.invoke('file:write', p, content),
  openExternal: (p)          => ipcRenderer.invoke('file:openExternal', p)
});

contextBridge.exposeInMainWorld('sessionApi', {
  load: ()        => ipcRenderer.invoke('session:load'),
  save: (data)    => ipcRenderer.send('session:save', data),
  ages: (entries) => ipcRenderer.invoke('session:ages', entries)
});

contextBridge.exposeInMainWorld('shortcuts', {
  onSplitH: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:split-h', listener);
    return () => ipcRenderer.removeListener('app:split-h', listener);
  },
  onCtrlZ: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:ctrl-z', listener);
    return () => ipcRenderer.removeListener('app:ctrl-z', listener);
  },
  // Report whether a real text field has focus, so main leaves native undo/redo alone.
  setTextFieldFocus: (focused) => ipcRenderer.send('app:text-field-focus', !!focused)
});
