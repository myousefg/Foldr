const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Open native folder picker; returns path string or null
  selectFolder: (opts) => ipcRenderer.invoke('select-folder', opts),

  // Open a folder in Explorer/Finder
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),

  // Common system paths { home, downloads, documents, desktop }
  getPaths: () => ipcRenderer.invoke('get-paths'),

  // Is this running inside Electron?
  isElectron: true,
});
