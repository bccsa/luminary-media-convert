import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The whole of the renderer's access to this machine.
 *
 * A short list and no general-purpose escape hatch: the API token it must send,
 * the real path of a file the user dropped, a native file picker, and which
 * session a CMS just asked to open. Anything else the app does, it does over
 * HTTP against the local API like any other client, which keeps one set of
 * rules about what is allowed.
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

    /**
     * The session a CMS opened while the app was already running.
     *
     * A push, for the common case: the window is up and the user is looking at
     * some other session.
     */
    onShowSession: (handler: (sessionId: string) => void): (() => void) => {
        const listener = (_event: unknown, sessionId: string) => handler(sessionId);
        ipcRenderer.on('luminary:showSession', listener);
        return () => ipcRenderer.off('luminary:showSession', listener);
    },

    /**
     * The session a CMS opened *before* this renderer existed — the click that
     * created it having launched the app through the protocol handler. Claimed
     * once: the main process forgets it as soon as it is handed over, so a
     * later reload does not navigate away from wherever the user has got to.
     */
    takePendingSession: (): Promise<string | null> =>
        ipcRenderer.invoke('luminary:takePendingSession'),
});
