import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The whole of the renderer's access to this machine.
 *
 * Three calls, no general-purpose escape hatch: the API token it must send,
 * the real path of a file the user dropped, and a native file picker. Anything
 * else the app does, it does over HTTP against the local API like any other
 * client, which keeps one set of rules about what is allowed.
 */
contextBridge.exposeInMainWorld('luminary', {
    getApiToken: (): Promise<string> => ipcRenderer.invoke('luminary:getApiToken'),

    /**
     * The path behind a `File` from a drop or an `<input>`.
     *
     * `File.path` was removed in Electron 32; this is its replacement, and it
     * has to be called in the preload because `webUtils` is not exposed to the
     * page. Encoding reads the file from disk rather than having the renderer
     * push gigabytes through the bridge.
     */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),

    showOpenDialog: (): Promise<string | null> =>
        ipcRenderer.invoke('luminary:showOpenDialog'),
});
