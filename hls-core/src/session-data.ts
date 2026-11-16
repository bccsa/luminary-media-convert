/**
 * The master playlist as the index of a video's sidecars.
 *
 * Nothing the encoder publishes is rewritten under the same name, so a sidecar
 * that changes (a chapter file, a thumbnail strip) gets a new name, and the
 * master — the one address the CMS holds — says which name is current, in
 * `#EXT-X-SESSION-DATA` lines:
 *
 *   #EXT-X-SESSION-DATA:DATA-ID="com.luminary.chapters",LANGUAGE="en",URI="chapters/en_1a2b3c4d.vtt",FORMAT=RAW
 *   #EXT-X-SESSION-DATA:DATA-ID="com.luminary.thumbnails",URI="thumbnails/thumbnails.vtt",FORMAT=RAW
 *   #EXT-X-SESSION-DATA:DATA-ID="com.luminary.thumbnails.main",VIDEO="main",URI="thumbnails/thumbnails_9f8e7d6c.vtt",FORMAT=RAW
 *
 * `FORMAT=RAW` because the HLS spec requires a `URI` without it to name JSON.
 *
 * A thumbnail strip can belong to one camera angle: `VIDEO` names the angle's
 * `TYPE=VIDEO` group, as `EXT-X-STREAM-INF`'s own `VIDEO` attribute does. The
 * angle is in the DATA-ID as well because the spec forbids two lines with the
 * same DATA-ID and LANGUAGE; readers go by `VIDEO`, the suffix only keeps the
 * lines distinct.
 *
 * Edits work on the text, line by line, so everything else in the master stays
 * as it was written. The parser keeps these lines verbatim as raw layout items,
 * so a master that has been through `parseMasterPlaylist` / `buildMasterPlaylist`
 * still carries them.
 */
import {
    formatAttributeList,
    parseAttributeList,
    type HlsAttribute,
} from './attributes.js';

/** Chapter files, one line per language. */
export const LUMINARY_CHAPTERS_DATA_ID = 'com.luminary.chapters';
/** Thumbnail strips (scrub previews): one for every angle, or one per angle. */
export const LUMINARY_THUMBNAILS_DATA_ID = 'com.luminary.thumbnails';

const LUMINARY_DATA_ID_PREFIX = 'com.luminary.';
const SESSION_DATA_TAG = '#EXT-X-SESSION-DATA:';

export interface SessionDataEntry {
    dataId: string;
    /** Relative to the master, as written. */
    uri?: string;
    language?: string;
    /** `GROUP-ID` of the `TYPE=VIDEO` group (camera angle) the entry belongs to. */
    video?: string;
    value?: string;
    format?: string;
}

function entryOf(line: string): SessionDataEntry | undefined {
    if (!line.startsWith(SESSION_DATA_TAG)) return undefined;
    const attrs = parseAttributeList(line.slice(SESSION_DATA_TAG.length));
    const get = (name: string) => attrs.find((a) => a.name === name)?.value;
    const dataId = get('DATA-ID');
    if (!dataId) return undefined;
    const entry: SessionDataEntry = { dataId };
    const uri = get('URI');
    const language = get('LANGUAGE');
    const video = get('VIDEO');
    const value = get('VALUE');
    const format = get('FORMAT');
    if (uri !== undefined) entry.uri = uri;
    if (language !== undefined) entry.language = language;
    if (video !== undefined) entry.video = video;
    if (value !== undefined) entry.value = value;
    if (format !== undefined) entry.format = format;
    return entry;
}

function lineOf(entry: SessionDataEntry): string {
    const attrs: HlsAttribute[] = [
        { name: 'DATA-ID', value: entry.dataId, quoted: true },
    ];
    if (entry.language !== undefined) {
        attrs.push({ name: 'LANGUAGE', value: entry.language, quoted: true });
    }
    if (entry.video !== undefined) {
        attrs.push({ name: 'VIDEO', value: entry.video, quoted: true });
    }
    if (entry.value !== undefined) {
        attrs.push({ name: 'VALUE', value: entry.value, quoted: true });
    }
    if (entry.uri !== undefined) {
        attrs.push({ name: 'URI', value: entry.uri, quoted: true });
    }
    if (entry.format !== undefined) {
        attrs.push({ name: 'FORMAT', value: entry.format, quoted: false });
    }
    return SESSION_DATA_TAG + formatAttributeList(attrs);
}

function sameKey(
    a: SessionDataEntry,
    dataId: string,
    language?: string
): boolean {
    return a.dataId === dataId && a.language === language;
}

function splitLines(text: string): { lines: string[]; eol: string } {
    return {
        eol: text.includes('\r\n') ? '\r\n' : '\n',
        lines: text.split(/\r?\n/),
    };
}

/** Every `#EXT-X-SESSION-DATA` entry of a master, or only those with `dataId`. */
export function listSessionData(
    text: string,
    dataId?: string
): SessionDataEntry[] {
    const out: SessionDataEntry[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const entry = entryOf(raw.trim());
        if (entry && (dataId === undefined || entry.dataId === dataId)) {
            out.push(entry);
        }
    }
    return out;
}

/**
 * The master with `entry` in it: the line with the same DATA-ID and LANGUAGE
 * is replaced, or a new line goes after the header tags, before the first
 * rendition or variant.
 */
export function upsertSessionData(
    text: string,
    entry: SessionDataEntry
): string {
    const { lines, eol } = splitLines(text);
    const own = lines.findIndex((line) => {
        const current = entryOf(line.trim());
        return !!current && sameKey(current, entry.dataId, entry.language);
    });
    if (own >= 0) {
        lines[own] = lineOf(entry);
    } else {
        lines.splice(insertionPoint(lines), 0, lineOf(entry));
    }
    return lines.join(eol);
}

/** The master without the line(s) for `dataId` (and `language`, when given). */
export function removeSessionData(
    text: string,
    dataId: string,
    language?: string
): string {
    const { lines, eol } = splitLines(text);
    return lines
        .filter((line) => {
            const entry = entryOf(line.trim());
            if (!entry || entry.dataId !== dataId) return true;
            return language !== undefined && entry.language !== language;
        })
        .join(eol);
}

/**
 * The master without any `com.luminary.*` lines — what a player hands its
 * engine, which has no use for them and would resolve their relative URIs
 * against wherever the rebuilt master is served from.
 */
export function stripLuminarySessionData(text: string): string {
    const { lines, eol } = splitLines(text);
    return lines
        .filter((line) => {
            const entry = entryOf(line.trim());
            return !entry || !entry.dataId.startsWith(LUMINARY_DATA_ID_PREFIX);
        })
        .join(eol);
}

/**
 * Where a new session-data line goes: after the last session-data line if
 * there is one, else after the header tags, before the first rendition,
 * variant or I-frame stream.
 */
function insertionPoint(lines: string[]): number {
    let lastSessionData = -1;
    for (const [i, line] of lines.entries()) {
        if (line.trim().startsWith(SESSION_DATA_TAG)) lastSessionData = i;
    }
    if (lastSessionData >= 0) return lastSessionData + 1;
    const body = lines.findIndex((line) => {
        const l = line.trim();
        return (
            l.startsWith('#EXT-X-MEDIA:') ||
            l.startsWith('#EXT-X-STREAM-INF:') ||
            l.startsWith('#EXT-X-I-FRAME-STREAM-INF:')
        );
    });
    if (body >= 0) return body;
    // A master with nothing in it yet: append, ahead of any trailing blank line.
    let end = lines.length;
    while (end > 0 && lines[end - 1]!.trim() === '') end--;
    return end;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/** The line naming `language`'s chapter file. */
export function chaptersEntry(language: string, uri: string): SessionDataEntry {
    return { dataId: LUMINARY_CHAPTERS_DATA_ID, language, uri, format: 'RAW' };
}

/** Chapter files the master names, one per language. */
export function listChapterEntries(text: string): SessionDataEntry[] {
    return listSessionData(text, LUMINARY_CHAPTERS_DATA_ID).filter(
        (e) => !!e.uri && !!e.language
    );
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** `com.luminary.thumbnails`, or `com.luminary.thumbnails.<GROUP-ID>` for one angle. */
export function thumbnailsDataId(angleId?: string): string {
    return angleId
        ? `${LUMINARY_THUMBNAILS_DATA_ID}.${angleId}`
        : LUMINARY_THUMBNAILS_DATA_ID;
}

/** The line naming a thumbnail strip, for every angle or for `angleId`'s. */
export function thumbnailsEntry(
    uri: string,
    angleId?: string
): SessionDataEntry {
    return {
        dataId: thumbnailsDataId(angleId),
        ...(angleId ? { video: angleId } : {}),
        uri,
        format: 'RAW',
    };
}

/** Every thumbnail strip the master names, per-angle ones included. */
export function listThumbnailEntries(text: string): SessionDataEntry[] {
    return listSessionData(text).filter(
        (e) =>
            !!e.uri &&
            (e.dataId === LUMINARY_THUMBNAILS_DATA_ID ||
                e.dataId.startsWith(`${LUMINARY_THUMBNAILS_DATA_ID}.`))
    );
}

/**
 * The strip to show on angle `angleId`:
 *
 * 1. the one for that angle;
 * 2. else the one for every angle;
 * 3. else the first per-angle one — today's behaviour, one strip on every angle;
 * 4. else none, and the caller falls back to `thumbnails/thumbnails.vtt`.
 */
export function resolveThumbnails(
    entries: readonly SessionDataEntry[],
    angleId?: string | null
): SessionDataEntry | undefined {
    if (angleId) {
        const own = entries.find((e) => e.video === angleId);
        if (own) return own;
    }
    return entries.find((e) => e.video === undefined) ?? entries[0];
}

// ---------------------------------------------------------------------------
// Master revisions
// ---------------------------------------------------------------------------

const REVISION_PATTERN = /^(.+)_r(\d+)\.m3u8$/i;

/**
 * A master playlist's name as a revision of its video's master: the encode's
 * `master.m3u8` is revision 0, each edit writes `master_r1.m3u8`,
 * `master_r2.m3u8`, … in the same folder. Undefined for a name that is not a
 * playlist.
 */
export function parseMasterRevision(
    basename: string
): { stem: string; n: number } | undefined {
    const m = REVISION_PATTERN.exec(basename);
    if (m) return { stem: m[1]!, n: Number(m[2]) };
    if (!/\.m3u8$/i.test(basename) || basename.length <= '.m3u8'.length) {
        return undefined;
    }
    return { stem: basename.slice(0, -'.m3u8'.length), n: 0 };
}

/** The file name of revision `n` of the master whose stem is `stem`. */
export function masterRevisionName(stem: string, n: number): string {
    return n === 0 ? `${stem}.m3u8` : `${stem}_r${n}.m3u8`;
}

/** The name the revision after `basename` is written under. */
export function nextMasterRevisionName(basename: string): string {
    const revision = parseMasterRevision(basename);
    if (!revision) {
        throw new Error(`${basename} is not a master playlist name`);
    }
    return masterRevisionName(revision.stem, revision.n + 1);
}
