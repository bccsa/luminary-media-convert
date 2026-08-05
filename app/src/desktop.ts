/**
 * The bridge the Electron preload exposes, typed.
 *
 * Only present in the desktop build — on the web `window.luminary` is
 * undefined, which is what `isDesktop` checks. Guarding on the object rather
 * than on the `__DESKTOP__` build flag means a mismatch between the two shows
 * up as a disabled button rather than a crash.
 */

export interface LocalFile {
    /** Absolute path on the user's machine. */
    path: string;
    name: string;
    size: number;
}

interface LuminaryBridge {
    isDesktop: true;
    pickFile(): Promise<LocalFile | null>;
    pathForFile(file: File): string | null;
    statFile(path: string): Promise<LocalFile | null>;
}

declare global {
    interface Window {
        luminary?: LuminaryBridge;
    }
}

function bridge(): LuminaryBridge | undefined {
    return typeof window === 'undefined' ? undefined : window.luminary;
}

export function isDesktop(): boolean {
    return bridge()?.isDesktop === true;
}

/** Native open dialog. Null when cancelled, or when not running in Electron. */
export async function pickLocalFile(): Promise<LocalFile | null> {
    return (await bridge()?.pickFile()) ?? null;
}

/**
 * Where a dropped file came from.
 *
 * Drag and drop still yields a File; this recovers the path behind it so the
 * encoder can read it in place instead of the app uploading bytes it already
 * has on the same disk.
 */
export async function localFileFromDrop(file: File): Promise<LocalFile | null> {
    const api = bridge();
    if (!api) return null;

    const path = api.pathForFile(file);
    if (!path) return null;

    return { path, name: file.name, size: file.size };
}
