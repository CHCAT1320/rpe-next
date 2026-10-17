const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rpenDesktopStorage', {
  version: 1,
  call: (method, ...args) => ipcRenderer.invoke('rpen-native-storage', { method, args }),
});
