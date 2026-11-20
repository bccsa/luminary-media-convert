import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What the app remembers between launches, in `settings.json` under the user's
 * data directory.
 *
 * Kept apart from main.ts so the load/save round trip can be tested without
 * Electron: the path is passed in, and main.ts supplies the real one.
 */
export interface Settings {
    /** Origins the user has allowed. Loaded into the API's allowlist at boot. */
    allowedOrigins: string[];
    /**
     * Origins the user has refused. Kept so a site that keeps trying cannot
     * turn "no" into a dialog every few seconds until someone clicks the wrong
     * button.
     */
    deniedOrigins: string[];
    /**
     * A directory holding an ffmpeg the user would rather we used than the one
     * we ship. Unset for everybody who has never opened the menu item.
     *
     * A directory rather than two file paths, so ffmpeg and ffprobe cannot be
     * chosen from different builds — a pair that disagree fail in ways that
     * look like a broken source file.
     */
    ffmpegDir?: string | null;
    /**
     * A release the user said to stop mentioning. Only that version: the next
     * one is announced again, so "skip" never quietly becomes "never".
     */
    skippedVersion?: string | null;
}

/** A first run: no site trusted, no site refused, the bundled ffmpeg. */
export function defaultSettings(): Settings {
    return {
        allowedOrigins: [],
        deniedOrigins: [],
        ffmpegDir: null,
        skippedVersion: null,
    };
}

/**
 * The settings stored at `path`. A file that is missing, unreadable or not
 * JSON gives the first-run settings, "trust nothing"; a file missing some
 * fields, or holding one of the wrong type, keeps the rest and starts those
 * fresh.
 */
export async function loadSettings(path: string): Promise<Settings> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
        return defaultSettings();
    }
    if (typeof parsed !== 'object' || parsed === null) return defaultSettings();
    const stored = parsed as Record<string, unknown>;
    const origins = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.filter((o): o is string => typeof o === 'string')
            : [];
    const text = (value: unknown): string | null =>
        typeof value === 'string' ? value : null;
    return {
        allowedOrigins: origins(stored.allowedOrigins),
        deniedOrigins: origins(stored.deniedOrigins),
        ffmpegDir: text(stored.ffmpegDir),
        skippedVersion: text(stored.skippedVersion),
    };
}

/**
 * Writes `settings` to `path`, creating its directory. A failure is reported
 * to `onError` rather than thrown: the decision the user just made still holds
 * for this run, it is only not remembered.
 */
export async function saveSettings(
    path: string,
    settings: Settings,
    onError: (err: unknown) => void
): Promise<void> {
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(settings, null, 4), 'utf8');
    } catch (err) {
        onError(err);
    }
}
