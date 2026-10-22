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
  paneSession: (ptyId, sinceMs, cwd) => ipcRenderer.invoke('claude:paneSession', ptyId, sinceMs, cwd),
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

contextBridge.exposeInMainWorld('ghApi', {
  status:      ()     => ipcRenderer.invoke('gh:status'),
  repoForCwd:  (cwd)  => ipcRenderer.invoke('gh:repoForCwd', cwd),
  myRepos:     ()     => ipcRenderer.invoke('gh:myRepos'),
  prs:         (args) => ipcRenderer.invoke('gh:prs', args),
  issues:      (args) => ipcRenderer.invoke('gh:issues', args),
  runs:        (args) => ipcRenderer.invoke('gh:runs', args),
  inbox:       (args) => ipcRenderer.invoke('gh:inbox', args),
  item:        (args) => ipcRenderer.invoke('gh:item', args),
  merge:       (args) => ipcRenderer.invoke('gh:merge', args),
  requestCopilotReview: (args) => ipcRenderer.invoke('gh:requestCopilotReview', args),
  prForBranch: (cwd)  => ipcRenderer.invoke('gh:prForBranch', cwd),
  openWindow:  (url)  => ipcRenderer.invoke('gh:openWindow', url),
  worktree:    (args) => ipcRenderer.invoke('gh:worktree', args),
  ownerType:   (o)    => ipcRenderer.invoke('gh:ownerType', o),
  secretList:  (s)    => ipcRenderer.invoke('gh:secretList', s),
  secretSet:   (args) => ipcRenderer.invoke('gh:secretSet', args),
  secretDelete:(args) => ipcRenderer.invoke('gh:secretDelete', args),
  varList:     (s)    => ipcRenderer.invoke('gh:varList', s),
  varSet:      (args) => ipcRenderer.invoke('gh:varSet', args),
  varDelete:   (args) => ipcRenderer.invoke('gh:varDelete', args),
  envList:     (args) => ipcRenderer.invoke('gh:envList', args),
  envSave:     (args) => ipcRenderer.invoke('gh:envSave', args),
  envDelete:   (args) => ipcRenderer.invoke('gh:envDelete', args),
  deployStatus: (entry) => ipcRenderer.invoke('gh:deployStatus', entry),
  deployReview: (args)  => ipcRenderer.invoke('gh:deployReview', args)
});

contextBridge.exposeInMainWorld('notesApi', {
  load: ()     => ipcRenderer.invoke('notes:load'),
  save: (data) => ipcRenderer.send('notes:save', data),
  path: ()     => ipcRenderer.invoke('notes:path'),
  status: ()   => ipcRenderer.invoke('notes:status'),
  saveImage:   (args) => ipcRenderer.invoke('notes:saveImage', args),
  readImage:   (args) => ipcRenderer.invoke('notes:readImage', args),
  imageDir:    ()     => ipcRenderer.invoke('notes:imageDir'),
  deleteImage: (args) => ipcRenderer.invoke('notes:deleteImage', args),
  pruneImages: (keep) => ipcRenderer.invoke('notes:pruneImages', keep)
});

// Mac Code's own errors -> notes. onNote: formatted records pushed by main (only after
// takePending has run); takePending: records queued while the renderer wasn't ready (also
// switches live delivery on); log: raw renderer errors for errors.log.
contextBridge.exposeInMainWorld('errorsApi', {
  onNote: (callback) => {
    const listener = (_event, rec) => callback(rec);
    ipcRenderer.on('errors:note', listener);
    return () => ipcRenderer.removeListener('errors:note', listener);
  },
  takePending: () => ipcRenderer.invoke('errors:takePending'),
  log: (rec) => ipcRenderer.send('errors:log', rec)
});

// `initial` is read synchronously here so the renderer has settings before its first
// tab (terminal options, session restore) without awaiting anything.
contextBridge.exposeInMainWorld('settingsApi', {
  initial:    ipcRenderer.sendSync('settings:getSync'),
  get:        ()      => ipcRenderer.invoke('settings:get'),
  set:        (patch) => ipcRenderer.invoke('settings:set', patch),
  setSync:    (patch) => ipcRenderer.sendSync('settings:setSync', patch),
  reset:      ()      => ipcRenderer.invoke('settings:reset'),
  reload:     ()      => ipcRenderer.invoke('settings:reload'),
  path:       ()      => ipcRenderer.invoke('settings:path'),
  check:      ()      => ipcRenderer.invoke('settings:check'),
  exportFile: ()      => ipcRenderer.invoke('settings:export'),
  importFile: ()      => ipcRenderer.invoke('settings:import'),
  version:    ()      => ipcRenderer.invoke('app:version'),
  onChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  }
});

// Global Claude agents / skills / hooks (~/.claude). Every call takes one args object;
// see the ccfg:* handlers in main.js.
contextBridge.exposeInMainWorld('claudeCfgApi', {
  list:           ()     => ipcRenderer.invoke('ccfg:list'),
  agentSetModel:  (args) => ipcRenderer.invoke('ccfg:agentSetModel', args),
  agentCreate:    (args) => ipcRenderer.invoke('ccfg:agentCreate', args),
  agentDelete:    (args) => ipcRenderer.invoke('ccfg:agentDelete', args),
  agentPath:      (args) => ipcRenderer.invoke('ccfg:agentPath', args),
  skillCreate:    (args) => ipcRenderer.invoke('ccfg:skillCreate', args),
  skillDelete:    (args) => ipcRenderer.invoke('ccfg:skillDelete', args),
  skillPath:      (args) => ipcRenderer.invoke('ccfg:skillPath', args),
  hookAdd:        (args) => ipcRenderer.invoke('ccfg:hookAdd', args),
  hookUpdate:     (args) => ipcRenderer.invoke('ccfg:hookUpdate', args),
  hookRemove:     (args) => ipcRenderer.invoke('ccfg:hookRemove', args),
  hookDisable:    (args) => ipcRenderer.invoke('ccfg:hookDisable', args),
  hookEnable:     (args) => ipcRenderer.invoke('ccfg:hookEnable', args),
  hookScriptPath: (args) => ipcRenderer.invoke('ccfg:hookScriptPath', args)
});

// Claude flows (Settings → Flöden). Not `flowApi`: that name is the live /orchestrate
// flow-state view below.
contextBridge.exposeInMainWorld('flowCfgApi', {
  list:       ()     => ipcRenderer.invoke('flowcfg:list'),
  get:        (args) => ipcRenderer.invoke('flowcfg:get', args),
  save:       (args) => ipcRenderer.invoke('flowcfg:save', args),
  delete:     (args) => ipcRenderer.invoke('flowcfg:delete', args),
  preview:    (args) => ipcRenderer.invoke('flowcfg:preview', args),
  writeSkill: (args) => ipcRenderer.invoke('flowcfg:writeSkill', args)
});

contextBridge.exposeInMainWorld('fileApi', {
  read:         (p)          => ipcRenderer.invoke('file:read', p),
  write:        (p, content) => ipcRenderer.invoke('file:write', p, content),
  openExternal: (p)          => ipcRenderer.invoke('file:openExternal', p),
  openFolderUri: (uri, opts) => ipcRenderer.invoke('file:openFolderUri', uri, opts)
});

contextBridge.exposeInMainWorld('flowApi', {
  list: () => ipcRenderer.invoke('flow:list'),
  onUpdate: (callback) => {
    const listener = (_event, views) => callback(views);
    ipcRenderer.on('flow:update', listener);
    return () => ipcRenderer.removeListener('flow:update', listener);
  }
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
  onBeforeClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-close', listener);
    return () => ipcRenderer.removeListener('app:before-close', listener);
  },
  closeReady: () => ipcRenderer.send('app:close-ready'),
  // Report whether a real text field has focus, so main leaves native undo/redo alone.
  setTextFieldFocus: (focused) => ipcRenderer.send('app:text-field-focus', !!focused)
});
