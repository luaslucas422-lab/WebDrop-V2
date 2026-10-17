const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('webdrop', {
  unlock: (pw) => ipcRenderer.invoke('webdrop-unlock', String(pw || '')),
  name: () => ipcRenderer.invoke('webdrop-name'),
});
