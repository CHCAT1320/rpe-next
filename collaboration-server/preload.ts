// A sandboxed preload is loaded as CommonJS and gets NO type stripping, unlike every other TypeScript
// entry point in this repository: Electron hands the file straight to the sandboxed loader, so a type
// annotation here fails at runtime with "SyntaxError: Missing initializer in const declaration".
// The extension is `.ts` for consistency with the rest of the package, but this file must stay free
// of type syntax, and `require` must stay `require` because the sandbox provides no ES module loader.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serverManager', {
  action: (action, values) => ipcRenderer.invoke('server-action', action, values),
  subscribe: callback => ipcRenderer.on('server-state', (event, state) => callback(state))
});
