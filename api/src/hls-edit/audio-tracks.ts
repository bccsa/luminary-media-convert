import { BadRequestException } from '@nestjs/common';
import type { HlsParsedMaster } from '@luminary-media-converter/hls-core';

/**
 * An audio track as a viewer sees it: one language and name, however many
 * audio groups (stereo, mono, one per angle) carry a rendition of it. The
 * players fold the groups together on `LANGUAGE|NAME`, so this is the unit an
 * edit has to work on.
 */
export interface AudioTrack {
    language: string;
    name: string;
    /** The audio groups with a rendition of this track. */
    groups: string[];
    /** `DEFAULT=YES` in any group. */
    default: boolean;
}

/** A change to one track: the track as it is, and what it becomes. */
export interface AudioTrackEdit {
    from: { language: string; name: string };
    to: { language: string; name: string };
}

/** ISO 639-1 or 639-2 (two or three letters), with an optional region. */
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
/** A quoted-string in an attribute list cannot hold a quote or a line break. */
const NAME_FORBIDDEN = /["\r\n]/;
const NAME_MAX = 100;

const signature = (language: string | undefined, name: string): string =>
    `${language ?? ''}|${name}`;

/** The master's audio tracks, in the order they first appear. */
export function listAudioTracks(master: HlsParsedMaster): AudioTrack[] {
    const tracks = new Map<string, AudioTrack>();
    for (const media of master.media) {
        if (media.type !== 'AUDIO') continue;
        const key = signature(media.language, media.name);
        let track = tracks.get(key);
        if (!track) {
            track = {
                language: media.language ?? '',
                name: media.name,
                groups: [],
                default: false,
            };
            tracks.set(key, track);
        }
        if (!track.groups.includes(media.groupId)) {
            track.groups.push(media.groupId);
        }
        if (media.default) track.default = true;
    }
    return [...tracks.values()];
}

/**
 * Applies `edits` to every audio rendition of each track, in every group, so
 * the groups keep folding together. Only `LANGUAGE` and `NAME` change.
 *
 * Throws, leaving `master` untouched, when an edit names a track the master
 * does not have, gives an invalid language or name, or would leave one group
 * with two renditions of the same language and name.
 */
export function applyAudioTrackEdits(
    master: HlsParsedMaster,
    edits: AudioTrackEdit[]
): void {
    const known = new Set(
        listAudioTracks(master).map((t) => signature(t.language, t.name))
    );
    const bySource = new Map<string, AudioTrackEdit['to']>();
    for (const edit of edits) {
        const from = signature(edit.from.language, edit.from.name);
        if (!known.has(from)) {
            throw new BadRequestException(
                `No audio track "${edit.from.name}" (${edit.from.language || 'no language'})`
            );
        }
        if (bySource.has(from)) {
            throw new BadRequestException(
                `Audio track "${edit.from.name}" is edited twice`
            );
        }
        const language = edit.to.language.trim();
        const name = edit.to.name.trim();
        if (!LANGUAGE.test(language)) {
            throw new BadRequestException(
                `"${edit.to.language}" is not a language code (ISO 639, e.g. "en" or "fra")`
            );
        }
        if (!name || name.length > NAME_MAX || NAME_FORBIDDEN.test(name)) {
            throw new BadRequestException(
                `A track name needs 1 to ${NAME_MAX} characters, without quotes or line breaks`
            );
        }
        bySource.set(from, { language, name });
    }

    // Checked on the result before anything is changed: an edit that leaves a
    // group with two renditions of one language and name would show the
    // viewer one track and play either. What the encode itself wrote is not
    // second-guessed.
    const after = new Map<string, Map<string, boolean>>();
    for (const media of master.media) {
        if (media.type !== 'AUDIO') continue;
        const to = bySource.get(signature(media.language, media.name));
        const key = to
            ? signature(to.language, to.name)
            : signature(media.language, media.name);
        const seen = after.get(media.groupId) ?? new Map<string, boolean>();
        if (seen.has(key) && (to || seen.get(key))) {
            throw new BadRequestException(
                `Two tracks in audio group "${media.groupId}" would have the same language and name`
            );
        }
        seen.set(key, seen.get(key) || !!to);
        after.set(media.groupId, seen);
    }

    for (const media of master.media) {
        if (media.type !== 'AUDIO') continue;
        const to = bySource.get(signature(media.language, media.name));
        if (!to) continue;
        media.language = to.language;
        media.name = to.name;
    }
}
