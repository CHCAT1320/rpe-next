const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serverManager', {
  action: (action, values) => ipcRenderer.invoke('server-action', action, values),
  subscribe: callback => ipcRenderer.on('server-state', (event, state) => callback(state))
});
