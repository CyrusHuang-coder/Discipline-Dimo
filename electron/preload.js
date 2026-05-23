const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openMainWindow: () => ipcRenderer.send('open-main-window'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  moveWindow: (x, y) => ipcRenderer.send('move-window', x, y)
});