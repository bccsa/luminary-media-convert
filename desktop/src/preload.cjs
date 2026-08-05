// CommonJS on purpose: a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * The renderer's only route out of the sandbox.
 *
 * Everything here is about picking a source file. The desktop app encodes from
 * disk rather than uploading, so what it needs is an absolute path — something
 * a browser deliberately never gives a web page.
 */
contextBridge.exposeInMainWorld('luminary', {
    /** Distinguishes the Electron build from the same code served on the web. */
    isDesktop: true,

    onStatus: (handler) =>
        ipcRenderer.on('status', (_event, status) => handler(status)),

    /**
     * Native open dialog. Returns { path, name, size } or null if cancelled.
     * Preferred over a file input: it yields a real path with no ambiguity, and
     * the extension filter comes from the encoder's own allow-list.
     */
    pickFile: () => ipcRenderer.invoke('pick-file'),

    /**
     * The path behind a dropped File.
     *
     * Drag and drop still produces a File object, and webUtils is the only way
     * to learn where it came from — `file.path` was removed in Electron 32.
     */
    pathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file) || null;
        } catch {
            return null;
        }
    },

    /** Size and name for a path, so the UI can show them without a File. */
    statFile: (path) => ipcRenderer.invoke('stat-file', path),
});
