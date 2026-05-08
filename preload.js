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
  usage: (cwd) => ipcRenderer.invoke('claude:usage', cwd)
});

contextBridge.exposeInMainWorld('fileApi', {
  read:         (p)          => ipcRenderer.invoke('file:read', p),
  write:        (p, content) => ipcRenderer.invoke('file:write', p, content),
  openExternal: (p)          => ipcRenderer.invoke('file:openExternal', p)
});
