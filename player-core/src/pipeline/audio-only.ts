/**
 * The audio-only pseudo-angle.
 *
 * Selecting {@link AUDIO_ONLY_ANGLE_ID} must download NO video at all — this is
 * for viewers on restricted bandwidth, so "the player happens to pick a low
 * rendition" is not good enough. The munged master therefore contains zero
 * video variants and zero `TYPE=VIDEO` media: the audio rendition groups are
 * promoted to variants and nothing else survives.
 */

import {
    buildMasterPlaylist,
    extractAudioOnlyPlaylist,
    parseMasterPlaylist,
    parseMediaPlaylist,
    type HlsParsedMaster,
} from '@luminary-media-converter/hls-core';
import { hasVideoVariants } from './playlist-text.js';

/**
 * Build the audio-only rendering of a master, or `null` when the master
 * declares no audio rendition groups to promote.
 */
export function buildAudioOnlyMaster(masterText: string): string | null {
    return extractAudioOnlyPlaylist(masterText);
}

/**
 * The audio-only master with each tier's `BANDWIDTH` measured from its media
 * playlist's segment sizes, where the playlist gives them (byte ranges). A
 * master cannot state an audio rendition's bitrate, so without this every tier
 * carries the same assumed one and the engine sees a single tier to play.
 */
export function measureAudioOnlyBandwidth(
    masterText: string,
    playlistText: (uri: string) => string | undefined,
): string {
    const master = parseMasterPlaylist(masterText);
    let changed = false;
    for (const variant of master.variants) {
        const text = playlistText(variant.uri);
        const measured = text === undefined ? undefined : measuredBitrate(text);
        if (!measured || measured === variant.bandwidth) continue;
        variant.bandwidth = measured;
        changed = true;
    }
    return changed ? buildMasterPlaylist(master) : masterText;
}

/** Bits per second over the whole playlist; undefined unless every segment states its size. */
function measuredBitrate(text: string): number | undefined {
    let bytes = 0;
    let seconds = 0;
    for (const segment of parseMediaPlaylist(text).segments) {
        if (!segment.byteRange) return undefined;
        bytes += segment.byteRange.length;
        seconds += segment.duration;
    }
    return bytes > 0 && seconds > 0 ? Math.round((bytes * 8) / seconds) : undefined;
}

/** True when an audio-only rendering can be derived from this master. */
export function hasAudioOnlyRendering(masterText: string): boolean {
    return canRenderAudioOnly(parseMasterPlaylist(masterText));
}

/**
 * {@link hasAudioOnlyRendering} against a model the caller already parsed.
 *
 * Asked rather than attempted: {@link buildAudioOnlyMaster} returns a playlist
 * exactly when some audio rendition names both a group and a URI, and building
 * and serializing a whole master only to compare it with `null` is the long
 * way to find that out.
 */
export function canRenderAudioOnly(master: HlsParsedMaster): boolean {
    return master.audioGroups.some((entry) => !!entry.groupId && !!entry.uri);
}

/**
 * True when a master carries no video whatsoever — no video variants, no
 * `TYPE=VIDEO` media groups. Used both to detect a natively audio-only source
 * and to assert the audio-only munge in specs.
 */
export function isAudioOnlyMaster(masterText: string): boolean {
    return !hasVideoVariants(masterText);
}

/**
 * Every playlist URI a master would make the engine fetch. Specs assert that
 * none of them is a video rendition after the audio-only munge.
 */
export function referencedPlaylistUris(masterText: string): string[] {
    const master = parseMasterPlaylist(masterText);
    return [
        ...new Set([
            ...master.variants.map((v) => v.uri),
            ...master.media.flatMap((m) => (m.uri ? [m.uri] : [])),
        ]),
    ];
}
