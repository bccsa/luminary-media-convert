/**
 * Client-side multi-angle extraction.
 *
 * The encoder writes one spec-correct multi-angle master playlist: each camera
 * angle is an `#EXT-X-MEDIA:TYPE=VIDEO` rendition group and every
 * `#EXT-X-STREAM-INF` carries `VIDEO="<group>"`. Most HLS players ignore video
 * rendition groups and just play whichever variant their ABR logic picks, so a
 * player that wants to pin one angle (or drop video altogether) has to narrow
 * the master itself. These helpers do exactly that, with no player or network
 * dependency.
 *
 * Two levels are offered:
 *
 * - {@link extractAngle} works on the parsed model, is pure, and is lossless —
 *   unmodeled tags and attributes survive. Compose it with quality capping and
 *   build once.
 * - {@link extractAnglePlaylist} / {@link extractAudioOnlyPlaylist} /
 *   {@link listVideoAngles} are the text-in/text-out helpers. They keep their
 *   long-standing output byte for byte, which means they also keep its
 *   narrowing: tags outside the model are dropped and the version defaults
 *   differ per function.
 */

import { buildMasterPlaylist } from './build.js';
import { copyAttributeSource } from './metadata.js';
import {
    getMasterLayout,
    parseMasterPlaylist,
    setMasterLayout,
    type HlsIFrameStream,
    type HlsMasterLayoutItem,
    type HlsMedia,
    type HlsParsedMaster,
    type HlsVariant,
} from './parse.js';

export interface VideoAngle {
    /** `GROUP-ID` of the video rendition group — pass to `extractAnglePlaylist`. */
    id: string;
    /** `NAME` attribute, or the id when the master omits one. */
    name: string;
    /** `DEFAULT=YES` — the angle a player should start on. */
    isDefault: boolean;
}

const DEFAULT_AUDIO_BANDWIDTH = 128_000;
const DEFAULT_AUDIO_CODEC = 'mp4a.40.2';
/** Version written into an extracted angle master when the source states none. */
const ANGLE_FALLBACK_VERSION = 3;
/** Version written into an audio-only master when the source states none. */
const AUDIO_ONLY_FALLBACK_VERSION = 7;

/**
 * List the video rendition groups (camera angles) in a master playlist.
 * Returns `[]` for a single-angle master, which has no `TYPE=VIDEO` groups.
 */
export function listVideoAngles(masterText: string): VideoAngle[] {
    return listAngles(parseMasterPlaylist(masterText));
}

/** {@link listVideoAngles} against an already-parsed master. */
export function listAngles(master: HlsParsedMaster): VideoAngle[] {
    const angles: VideoAngle[] = [];
    const seen = new Set<string>();

    for (const group of master.videoGroups) {
        if (!group.groupId || seen.has(group.groupId)) continue;
        seen.add(group.groupId);
        angles.push({
            id: group.groupId,
            name: group.name || group.groupId,
            isDefault: group.default === true,
        });
    }

    return angles;
}

/**
 * Narrow a multi-angle master to a single angle: keep only the variants
 * belonging to `angleId`, strip their now-meaningless `VIDEO` attribute, and
 * drop the `TYPE=VIDEO` media lines. Audio (and any other non-video) rendition
 * groups are carried over untouched, as are unmodeled tags.
 *
 * Pure and non-mutating. A master with no video groups — or one where
 * `angleId` matches nothing — is returned as-is (the identical object), so
 * callers can apply this unconditionally and detect the no-op by reference.
 */
export function extractAngle(
    master: HlsParsedMaster,
    angleId: string
): HlsParsedMaster {
    if (master.videoGroups.length === 0) return master;

    const kept = master.variants.filter((v) => v.videoGroup === angleId);
    if (kept.length === 0) return master;

    const variantByOriginal = new Map<HlsVariant, HlsVariant>();
    for (const original of kept) {
        variantByOriginal.set(original, withoutVideoGroup(original));
    }

    const iFrameByOriginal = new Map<HlsIFrameStream, HlsIFrameStream>();
    for (const original of master.iFrameStreams ?? []) {
        if (original.videoGroup && original.videoGroup !== angleId) continue;
        iFrameByOriginal.set(original, withoutVideoGroup(original));
    }

    const media = master.media.filter((m) => m.type !== 'VIDEO');
    const variants = kept.map((v) => variantByOriginal.get(v)!);
    const iFrameStreams = [...iFrameByOriginal.values()];

    const narrowed: HlsParsedMaster = {
        variants,
        media,
        audioGroups: media.filter((m) => m.type === 'AUDIO'),
        videoGroups: [],
        ...(master.version !== undefined ? { version: master.version } : {}),
        ...(master.independentSegments ? { independentSegments: true } : {}),
        ...(iFrameStreams.length > 0 ? { iFrameStreams } : {}),
    };

    const mediaSet = new Set<object>(master.media);
    const variantSet = new Set<object>(master.variants);

    const layout: HlsMasterLayoutItem[] = [];
    for (const item of getMasterLayout(master) ?? [
        ...master.media,
        ...master.variants,
        ...(master.iFrameStreams ?? []),
    ]) {
        if (typeof item === 'string') {
            layout.push(item);
        } else if (mediaSet.has(item)) {
            if ((item as HlsMedia).type !== 'VIDEO') layout.push(item);
        } else if (variantSet.has(item)) {
            const mapped = variantByOriginal.get(item as HlsVariant);
            if (mapped) layout.push(mapped);
        } else {
            const mapped = iFrameByOriginal.get(item as HlsIFrameStream);
            if (mapped) layout.push(mapped);
        }
    }
    setMasterLayout(narrowed, layout);

    return narrowed;
}

export function extractAnglePlaylist(
    masterText: string,
    angleId: string
): string {
    const master = parseMasterPlaylist(masterText);
    const narrowed = extractAngle(master, angleId);
    if (narrowed === master) return masterText;

    // Shaped to match this helper's long-standing output: model-level tags
    // only, media before variants, version 3 when the source states none.
    const legacy: HlsParsedMaster = {
        variants: narrowed.variants,
        media: narrowed.media,
        audioGroups: narrowed.audioGroups,
        videoGroups: [],
        version: narrowed.version ?? ANGLE_FALLBACK_VERSION,
    };
    setMasterLayout(legacy, [...narrowed.media, ...narrowed.variants]);
    return buildMasterPlaylist(legacy);
}

/**
 * Build an audio-only master from the audio rendition groups of `masterText`:
 * one variant per `GROUP-ID`, pointing at that group's first rendition.
 *
 * Bandwidth is read off the encoder's stream directory naming (`..._128kbps/`)
 * when present and otherwise assumed, since a master playlist never states the
 * bitrate of an audio rendition on its own. Codecs come from the audio token of
 * a variant that uses the group.
 *
 * Returns `null` when the master has no audio rendition groups.
 */
export function extractAudioOnlyPlaylist(masterText: string): string | null {
    const master = parseMasterPlaylist(masterText);

    /** GROUP-ID → the group's renditions, in playlist order. */
    const groups = new Map<string, HlsMedia[]>();
    for (const entry of master.audioGroups) {
        if (!entry.groupId || !entry.uri) continue;
        const members = groups.get(entry.groupId);
        if (members) members.push(entry);
        else groups.set(entry.groupId, [entry]);
    }
    if (groups.size === 0) return null;

    /** GROUP-ID → audio codec token from the first variant that states one. */
    const codecs = new Map<string, string>();
    for (const variant of master.variants) {
        const groupId = variant.audioGroup;
        if (!groupId || codecs.has(groupId)) continue;
        const codec = audioCodec(variant.codecs);
        if (codec) codecs.set(groupId, codec);
    }

    const media: HlsMedia[] = [];
    for (const members of groups.values()) media.push(...members);

    const variants: HlsVariant[] = [];
    for (const [groupId, members] of groups) {
        const bandwidth =
            Math.max(...members.map((m) => bitrateFromUri(m.uri!) ?? 0)) ||
            DEFAULT_AUDIO_BANDWIDTH;
        variants.push({
            bandwidth,
            codecs: codecs.get(groupId) ?? DEFAULT_AUDIO_CODEC,
            audioGroup: groupId,
            uri: members[0].uri!,
        });
    }

    const audioOnly: HlsParsedMaster = {
        variants,
        media,
        audioGroups: media,
        videoGroups: [],
        version: master.version ?? AUDIO_ONLY_FALLBACK_VERSION,
    };
    // The blank line between the media block and the variants is part of this
    // helper's established output.
    setMasterLayout(audioOnly, [...media, '', ...variants]);
    return buildMasterPlaylist(audioOnly);
}

function withoutVideoGroup<T extends { videoGroup?: string }>(entry: T): T {
    const copy = { ...entry };
    delete copy.videoGroup;
    copyAttributeSource(entry, copy, ['VIDEO']);
    return copy;
}

/**
 * The encoder names audio stream directories `stream_<tier>_<label>/`, where the
 * label defaults to the configured bitrate (`stream_hd_128kbps/playlist.m3u8`).
 */
function bitrateFromUri(uri: string): number | null {
    const match = uri.match(/(\d+)\s*kbps/i);
    return match ? parseInt(match[1], 10) * 1000 : null;
}

/** Pick the audio entry out of a `CODECS` list (`"avc1.64001f,mp4a.40.2"`). */
function audioCodec(codecList: string | undefined): string | undefined {
    if (!codecList) return undefined;
    return codecList
        .split(',')
        .map((c) => c.trim())
        .find((c) => /^(mp4a|ac-3|ec-3|opus|vorbis|fLaC|alac)/i.test(c));
}
