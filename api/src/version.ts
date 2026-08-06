import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The version this local encoder reports to the CMS.
 *
 * The CMS uses it to decide whether the installed app is new enough for what it
 * is about to ask for, so it has to be the real package version rather than a
 * constant that drifts. Read once at startup from `api/package.json` — the same
 * two-levels-up path from `src/` and from `dist/`.
 *
 * An unreadable package.json is not worth failing to boot over; an unknown
 * version reads as "too old" to any caller that checks, which is the safe way
 * to be wrong.
 */
function readVersion(): string {
    try {
        const path = join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
            version?: string;
        };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

export const API_VERSION = readVersion();
