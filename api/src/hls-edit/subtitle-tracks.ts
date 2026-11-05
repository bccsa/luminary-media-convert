/**
 * An existing video's subtitles, one language each, as `TYPE=SUBTITLES`
 * renditions of its master: what the players read, with no other address to
 * hand them. Each rendition is a media playlist with a single WebVTT segment
 * that spans the video.
 *
 * Edits are made on the master's text, line by line, so everything they do
 * not touch stays byte for byte as the encode wrote it.
 */
import { BadRequestException } from '@nestjs/common';
import type { HlsParsedMaster } from '@luminary-media-converter/hls-core';
import {
    MEDIA_TAG,
    assertTrackLabel,
    attributePattern,
    readAttribute,
    writeAttribute,
} from './audio-tracks.js';

/** The group a video's subtitles join when it has none yet. */
export const SUBTITLE_GROUP = 'subs';

const STREAM_INF = '#EXT-X-STREAM-INF:';

export interface SubtitleTrack {
    language: string;
    name: string;
    /** Its media playlist, relative to the master. */
    uri: string;
    default: boolean;
}

/** The subtitles a viewer can choose: forced renditions, which a player shows by itself, are left out. */
export function listSubtitleTracks(master: HlsParsedMaster): SubtitleTrack[] {
    return master.media
        .filter(
            (media) =>
                media.type === 'SUBTITLES' &&
                !media.forced &&
                !!media.language &&
                !!media.uri
        )
        .map((media) => ({
            language: media.language!,
            name: media.name,
            uri: media.uri!,
            default: media.default === true,
        }));
}

export interface SubtitleUpsert {
    language: string;
    name: string;
    /** The language's media playlist, relative to the master. */
    uri: string;
}

/**
 * Points the master at `upsert`'s media playlist for its language: a language
 * the master already has keeps its rendition line with a new name and URI, a
 * new one gets a line of its own (not the default: nothing starts on by
 * itself). The first subtitles of a video also join every variant to the
 * group, since a player reads a variant's subtitles only through it.
 */
export function upsertSubtitleLines(text: string, upsert: SubtitleUpsert): string {
    const { language, name } = assertTrackLabel(upsert.language, upsert.name);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const group = subtitleGroupOf(lines) ?? SUBTITLE_GROUP;

    const own = lines.findIndex((line) => isOwnRendition(line, group, language));
    for (const [i, line] of lines.entries()) {
        if (i === own || !isSubtitleLine(line, group)) continue;
        if (readAttribute(line.slice(MEDIA_TAG.length), 'NAME') === name) {
            throw new BadRequestException(
                `Another language's subtitles are already called "${name}"`
            );
        }
    }

    if (own >= 0) {
        let list = lines[own]!.slice(MEDIA_TAG.length);
        list = writeAttribute(list, 'NAME', name);
        list = writeAttribute(list, 'URI', upsert.uri);
        lines[own] = MEDIA_TAG + list;
    } else {
        const line =
            `${MEDIA_TAG}TYPE=SUBTITLES,GROUP-ID="${group}",NAME="${name}",` +
            `LANGUAGE="${language}",DEFAULT=NO,AUTOSELECT=YES,URI="${upsert.uri}"`;
        lines.splice(insertionPoint(lines, group), 0, line);
    }

    return lines
        .map((line) => {
            if (!line.startsWith(STREAM_INF)) return line;
            const list = line.slice(STREAM_INF.length);
            return readAttribute(list, 'SUBTITLES') === undefined
                ? STREAM_INF + writeAttribute(list, 'SUBTITLES', group)
                : line;
        })
        .join(eol);
}

/**
 * Takes `language`'s subtitles out of the master. When they were the last of
 * their group the variants leave it too, so no variant names a group that is
 * not there. Returns the removed rendition's URI, for its files to go.
 */
export function removeSubtitleLines(
    text: string,
    language: string
): { text: string; uri: string } {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const group = subtitleGroupOf(lines);
    const own = group === undefined ? -1 : lines.findIndex((line) => isOwnRendition(line, group, language));
    if (group === undefined || own < 0) {
        throw new BadRequestException(`This video has no "${language}" subtitles`);
    }
    const uri = readAttribute(lines[own]!.slice(MEDIA_TAG.length), 'URI') ?? '';
    lines.splice(own, 1);

    const groupLeft = lines.some((line) => isSubtitleLine(line, group, true));
    const out = groupLeft
        ? lines
        : lines.map((line) => {
              if (!line.startsWith(STREAM_INF)) return line;
              const list = line.slice(STREAM_INF.length);
              if (readAttribute(list, 'SUBTITLES') !== group) return line;
              return STREAM_INF + list.replace(attributePattern('SUBTITLES'), '').replace(/^,/, '');
          });
    return { text: out.join(eol), uri };
}

/** The group the master's chooseable subtitles are in; the first such rendition's. */
function subtitleGroupOf(lines: string[]): string | undefined {
    for (const line of lines) {
        if (!line.startsWith(MEDIA_TAG)) continue;
        const list = line.slice(MEDIA_TAG.length);
        if (readAttribute(list, 'TYPE') !== 'SUBTITLES') continue;
        if (readAttribute(list, 'FORCED') === 'YES') continue;
        const group = readAttribute(list, 'GROUP-ID');
        if (group) return group;
    }
    return undefined;
}

/** A `TYPE=SUBTITLES` line of `group`; forced ones only when `withForced`. */
function isSubtitleLine(line: string, group: string, withForced = false): boolean {
    if (!line.startsWith(MEDIA_TAG)) return false;
    const list = line.slice(MEDIA_TAG.length);
    return (
        readAttribute(list, 'TYPE') === 'SUBTITLES' &&
        readAttribute(list, 'GROUP-ID') === group &&
        (withForced || readAttribute(list, 'FORCED') !== 'YES')
    );
}

function isOwnRendition(line: string, group: string, language: string): boolean {
    return (
        isSubtitleLine(line, group) &&
        readAttribute(line.slice(MEDIA_TAG.length), 'LANGUAGE') === language
    );
}

/** After the group's last line; else after the last rendition line; else before the first variant. */
function insertionPoint(lines: string[], group: string): number {
    let lastOfGroup = -1;
    let lastMedia = -1;
    let firstVariant = -1;
    for (const [i, line] of lines.entries()) {
        if (isSubtitleLine(line, group, true)) lastOfGroup = i;
        if (line.startsWith(MEDIA_TAG)) lastMedia = i;
        if (firstVariant < 0 && line.startsWith(STREAM_INF)) firstVariant = i;
    }
    if (lastOfGroup >= 0) return lastOfGroup + 1;
    if (lastMedia >= 0) return lastMedia + 1;
    if (firstVariant >= 0) return firstVariant;
    return lines.length;
}

/** The VTT a language's file must be: WebVTT, and small enough for any subtitles there are. */
export const MAX_SUBTITLE_VTT_BYTES = 4 * 1024 * 1024;

/**
 * A language's media playlist: one WebVTT segment, the whole video long.
 * `TARGETDURATION` is that length rounded up, as HLS requires.
 */
export function subtitlePlaylist(vttUri: string, durationSec: number): string {
    const length = Math.max(1, durationSec);
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${Math.ceil(length)}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        `#EXTINF:${length.toFixed(3)},`,
        vttUri,
        '#EXT-X-ENDLIST',
        '',
    ].join('\n');
}

/** The segment's URI in a language's media playlist; the first non-tag line. */
export function segmentUriOf(playlist: string): string | undefined {
    return playlist
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#'));
}

/**
 * Where a language's files go, beside the master: a fresh `version` in the
 * names makes every save a new address, so no cache can hand out the words
 * from before it.
 */
export function subtitleFileNames(
    language: string,
    version: string
): { playlist: string; vtt: string } {
    const base = `${language}_${version}`;
    return { playlist: `subtitles/${base}.m3u8`, vtt: `${base}.vtt` };
}
