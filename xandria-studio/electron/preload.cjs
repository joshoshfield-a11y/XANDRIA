const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xandria', {
  saveFile: (name, content) => ipcRenderer.invoke('xandria:saveFile', name, content),
});
