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
    extractAudioOnlyPlaylist,
    parseMasterPlaylist,
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
