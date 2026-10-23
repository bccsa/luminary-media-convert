import { BadRequestException } from '@nestjs/common';
import {
    parseMasterPlaylist,
    type HlsParsedMaster,
} from '@luminary-media-converter/hls-core';

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

/**
 * A track's language and name, trimmed, or a 400 saying what is wrong with
 * them: an ISO 639 code, and a name an attribute list can carry.
 */
export function assertTrackLabel(
    language: string,
    name: string
): { language: string; name: string } {
    const lang = language.trim();
    const label = name.trim();
    if (!LANGUAGE.test(lang)) {
        throw new BadRequestException(
            `"${language}" is not a language code (ISO 639, e.g. "en" or "fra")`
        );
    }
    if (!label || label.length > NAME_MAX || NAME_FORBIDDEN.test(label)) {
        throw new BadRequestException(
            `A track name needs 1 to ${NAME_MAX} characters, without quotes or line breaks`
        );
    }
    return { language: lang, name: label };
}

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
        bySource.set(from, assertTrackLabel(edit.to.language, edit.to.name));
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

/**
 * `text`, a master playlist, with `edits` applied to the `NAME` and `LANGUAGE`
 * of its audio renditions and the `removed` tracks taken out of every group,
 * and every other byte left as it was: blank lines, attribute order and
 * spelling, everything a rebuilt playlist would redraw.
 *
 * A group whose default rendition is removed has its next one made the
 * default, so players still have one to start with. Removing takes the track
 * out of the master only: its files stay where they are.
 *
 * Everything is checked on the parsed master first, so an invalid edit or
 * removal throws before anything is rewritten: a track that is not there, one
 * both renamed and removed, or a group that would be left without audio.
 */
export function rewriteAudioTracks(
    text: string,
    edits: AudioTrackEdit[],
    removed: { language: string; name: string }[] = []
): string {
    const master = parseMasterPlaylist(text);
    const known = new Set(
        listAudioTracks(master).map((t) => signature(t.language, t.name))
    );
    const gone = new Set<string>();
    for (const track of removed) {
        const key = signature(track.language, track.name);
        if (!known.has(key)) {
            throw new BadRequestException(
                `No audio track "${track.name}" (${track.language || 'no language'})`
            );
        }
        if (
            edits.some((e) => signature(e.from.language, e.from.name) === key)
        ) {
            throw new BadRequestException(
                `Audio track "${track.name}" is both renamed and removed`
            );
        }
        gone.add(key);
    }
    const isGone = (m: { type: string; language?: string; name: string }) =>
        m.type === 'AUDIO' && gone.has(signature(m.language, m.name));
    for (const groupId of new Set(
        master.media.filter((m) => m.type === 'AUDIO').map((m) => m.groupId)
    )) {
        const kept = master.media.filter(
            (m) => m.type === 'AUDIO' && m.groupId === groupId && !isGone(m)
        );
        if (kept.length === 0) {
            throw new BadRequestException(
                'A video keeps at least one audio track: add another before removing this one'
            );
        }
    }
    // Checked as the master will be once the removed tracks are out, so a
    // track may take the name of one removed in the same save.
    master.media = master.media.filter((m) => !isGone(m));
    applyAudioTrackEdits(master, edits);

    const targets = new Map(
        edits.map((edit) => [
            signature(edit.from.language, edit.from.name),
            { language: edit.to.language.trim(), name: edit.to.name.trim() },
        ])
    );
    const parts = text.split(/(\r?\n)/);
    const audioOf = (line: string) => {
        if (!line.startsWith(MEDIA_TAG)) return undefined;
        const attributes = line.slice(MEDIA_TAG.length);
        return readAttribute(attributes, 'TYPE') === 'AUDIO'
            ? attributes
            : undefined;
    };
    const lostDefault = new Set<string>();
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        const attributes = audioOf(parts[i]);
        if (attributes === undefined) {
            out.push(parts[i]);
            continue;
        }
        const key = signature(
            readAttribute(attributes, 'LANGUAGE'),
            readAttribute(attributes, 'NAME') ?? ''
        );
        if (gone.has(key)) {
            if (readAttribute(attributes, 'DEFAULT') === 'YES') {
                lostDefault.add(readAttribute(attributes, 'GROUP-ID') ?? '');
            }
            i++; // the line's own line end goes with it
            continue;
        }
        const to = targets.get(key);
        if (!to) {
            out.push(parts[i]);
            continue;
        }
        const named = writeAttribute(attributes, 'NAME', to.name);
        out.push(MEDIA_TAG + writeAttribute(named, 'LANGUAGE', to.language));
    }
    if (lostDefault.size > 0) {
        for (let i = 0; i < out.length; i++) {
            const attributes = audioOf(out[i]);
            const group = attributes && readAttribute(attributes, 'GROUP-ID');
            if (!attributes || !group || !lostDefault.has(group)) continue;
            out[i] =
                MEDIA_TAG + writeBareAttribute(attributes, 'DEFAULT', 'YES');
            lostDefault.delete(group);
        }
    }
    return out.join('');
}

const MEDIA_TAG = '#EXT-X-MEDIA:';

const attributePattern = (name: string): RegExp =>
    new RegExp(`(^|,)${name}=(?:"([^"]*)"|([^,]*))`);

function readAttribute(list: string, name: string): string | undefined {
    const match = attributePattern(name).exec(list);
    return match ? (match[2] ?? match[3]) : undefined;
}

/** Sets a quoted attribute in place, or adds it at the end when the line has none. */
function writeAttribute(list: string, name: string, value: string): string {
    const pattern = attributePattern(name);
    return pattern.test(list)
        ? list.replace(
              pattern,
              (_, lead: string) => `${lead}${name}="${value}"`
          )
        : `${list},${name}="${value}"`;
}

/** Sets an enumerated attribute (`DEFAULT=YES`) in place, or adds it at the end. */
function writeBareAttribute(list: string, name: string, value: string): string {
    const pattern = attributePattern(name);
    return pattern.test(list)
        ? list.replace(pattern, (_, lead: string) => `${lead}${name}=${value}`)
        : `${list},${name}=${value}`;
}

/** A new track's rendition in one audio group. */
export interface AddedRendition {
    groupId: string;
    /** Its media playlist, relative to the master. */
    uri: string;
    /** Written as `CHANNELS` when the group's other renditions state theirs. */
    channels: number;
}

/**
 * `text`, a master playlist, with a new audio track added to every audio group
 * it has a rendition for: one `#EXT-X-MEDIA` line each, after the group's last
 * one, and every other byte left as it was. The track is never the default;
 * the players pick by language.
 *
 * Throws, rewriting nothing, when the language or name is invalid, a group
 * already has a track of that language and name, or a group has no audio.
 */
export function addAudioTrackLines(
    text: string,
    label: { language: string; name: string },
    renditions: AddedRendition[]
): string {
    const { language, name } = assertTrackLabel(label.language, label.name);
    const master = parseMasterPlaylist(text);
    for (const rendition of renditions) {
        const group = master.media.filter(
            (m) => m.type === 'AUDIO' && m.groupId === rendition.groupId
        );
        if (group.length === 0) {
            throw new BadRequestException(
                `The video has no audio group "${rendition.groupId}"`
            );
        }
        if (
            group.some(
                (m) =>
                    signature(m.language, m.name) === signature(language, name)
            )
        ) {
            throw new BadRequestException(
                `The video already has an audio track "${name}" (${language})`
            );
        }
    }

    const lines = text.split(/(\r?\n)/);
    for (const rendition of renditions) {
        let last = -1;
        let statesChannels = false;
        lines.forEach((line, i) => {
            if (!line.startsWith(MEDIA_TAG)) return;
            const attributes = line.slice(MEDIA_TAG.length);
            if (readAttribute(attributes, 'TYPE') !== 'AUDIO') return;
            if (readAttribute(attributes, 'GROUP-ID') !== rendition.groupId)
                return;
            last = i;
            statesChannels ||=
                readAttribute(attributes, 'CHANNELS') !== undefined;
        });
        const eol = lines[last + 1] ?? '\n';
        const added =
            `${MEDIA_TAG}TYPE=AUDIO,GROUP-ID="${rendition.groupId}",NAME="${name}",` +
            `LANGUAGE="${language}",DEFAULT=NO,AUTOSELECT=YES,` +
            (statesChannels ? `CHANNELS="${rendition.channels}",` : '') +
            `URI="${rendition.uri}"`;
        lines.splice(last + 1, 0, eol, added);
    }
    return lines.join('');
}
