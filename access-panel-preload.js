// The access panel's bridge (access-panel.js): its rows in, a click on Open session out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accessPanel', {
  onRows: (callback) => ipcRenderer.on('access-panel-rows', (_event, rows) => callback(rows)),
  open: (sessionId) => ipcRenderer.send('access-panel-open', sessionId),
  resize: (height) => ipcRenderer.send('access-panel-height', height),
});
