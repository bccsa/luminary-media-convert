// CommonJS on purpose: a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('luminary', {
    onStatus: (handler) =>
        ipcRenderer.on('status', (_event, status) => handler(status)),
});
