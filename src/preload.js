const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  detectEncoders: () => ipcRenderer.invoke('detect-encoders'),
  makeProxy: (file) => ipcRenderer.invoke('make-proxy', file),
  exportVideo: (job) => ipcRenderer.invoke('export', job),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('export-progress', (_e, m) => cb(m)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
