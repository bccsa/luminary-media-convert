/**
 * The application menu, as a template: which items there are, where, and when
 * they can be used. Kept free of Electron at runtime so it can be tested;
 * `main.ts` supplies the actions and builds the menu from it.
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
    isMac: boolean;
    appName: string;
    /** A FFmpeg other than the bundled one is in use. */
    ffmpegDirChosen: boolean;
    /** Where the log file is, once it is open. */
    logPath: string | null;
    actions: {
        licences: () => void;
        chooseFfmpeg: () => void;
        useBundledFfmpeg: () => void;
        checkForUpdates: () => void;
        clearWorkingFiles: () => void;
        showLog: () => void;
    };
    /**
     * Tools for testing, in a Developer menu: given only to a development build,
     * never to the app people install.
     */
    developer?: {
        storageOffline: boolean;
        toggleStorageOffline: () => void;
    };
}

export function menuTemplate(opts: MenuOptions): MenuItemConstructorOptions[] {
    const { actions } = opts;
    // No ellipsis. Apple's convention reserves it for an item that needs more
    // input before it can act; this opens a window and asks for nothing. The
    // FFmpeg picker below keeps its ellipsis for exactly that reason.
    const licences = { label: 'Licences', click: actions.licences };
    // Deliberately a plain item rather than anything prominent: the licence
    // asks that substitution be possible, not that we recommend it.
    const ffmpegItems: MenuItemConstructorOptions[] = [
        { label: 'Choose FFmpeg…', click: actions.chooseFfmpeg },
        {
            label: 'Use the bundled FFmpeg',
            enabled: opts.ffmpegDirChosen,
            click: actions.useBundledFfmpeg,
        },
    ];

    // Ellipsis: it asks before it acts.
    const maintenanceItems: MenuItemConstructorOptions[] = [
        { label: 'Check for Updates…', click: actions.checkForUpdates },
        { label: 'Clear Working Files…', click: actions.clearWorkingFiles },
        // No ellipsis: it shows the file and asks nothing.
        {
            label: 'Show Log File',
            enabled: !!opts.logPath,
            click: actions.showLog,
        },
    ];

    return [
        ...(opts.isMac
            ? ([
                  {
                      label: opts.appName,
                      submenu: [
                          { role: 'about' },
                          { type: 'separator' },
                          ...ffmpegItems,
                          { type: 'separator' },
                          ...maintenanceItems,
                          { type: 'separator' },
                          { role: 'services' },
                          { type: 'separator' },
                          { role: 'hide' },
                          { role: 'hideOthers' },
                          { role: 'unhide' },
                          { type: 'separator' },
                          { role: 'quit' },
                      ],
                  },
              ] as MenuItemConstructorOptions[])
            : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        ...(opts.developer
            ? ([
                  {
                      label: 'Developer',
                      submenu: [
                          {
                              // Cuts storage only, so the rest of the machine stays online.
                              label: 'Storage Offline',
                              type: 'checkbox',
                              checked: opts.developer.storageOffline,
                              click: opts.developer.toggleStorageOffline,
                          },
                      ],
                  },
              ] as MenuItemConstructorOptions[])
            : []),
        {
            role: 'help',
            submenu: opts.isMac
                ? [licences]
                : [
                      licences,
                      { type: 'separator' },
                      ...ffmpegItems,
                      { type: 'separator' },
                      ...maintenanceItems,
                      { type: 'separator' },
                      { role: 'about' },
                  ],
        },
    ];
}
