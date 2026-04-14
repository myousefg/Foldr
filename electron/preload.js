const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder:   (opts) => ipcRenderer.invoke('select-folder', opts),
  openFolder:     (path) => ipcRenderer.invoke('open-folder', path),
  getPaths:       ()     => ipcRenderer.invoke('get-paths'),
  notify:         (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  setTrayBadge:   (count) => ipcRenderer.invoke('set-tray-badge', count),
  setAutoStart:   (enable) => ipcRenderer.invoke('set-auto-start', enable),
  getAutoStart:   ()     => ipcRenderer.invoke('get-auto-start'),
  isElectron: true,
});