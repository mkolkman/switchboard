// The access panel's bridge (access-panel.js): its rows in, its height out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accessPanel', {
  onRows: (callback) => ipcRenderer.on('access-panel-rows', (_event, rows) => callback(rows)),
  resize: (height) => ipcRenderer.send('access-panel-height', height),
});
