/**
 * The munging pipeline.
 *
 * Fetch master → derive angles/qualities/tracks → extract the requested angle →
 * cap quality → rewrite + serve the media playlists → serve the master → hand
 * the result to the adapter. An unencrypted master that needs no narrowing is
 * passed through by its original URL, so the common case costs nothing.
 */

import {
    extractAnglePlaylist,
    isEncryptedPayload,
    listVideoAngles,
} from '@luminary-media-converter/hls';
import {
    AUDIO_ONLY_ANGLE_ID,
    type AdapterSource,
    type Angle,
    type AudioTrack,
    type Quality,
    type ServeStrategy,
    type SubtitleTrack,
} from '../types.js';
import {
    buildAudioOnlyMaster,
    hasAudioOnlyRendering,
    isAudioOnlyMaster,
} from './audio-only.js';
import {
    KEY_CONTENT_TYPE,
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
} from './blob-registry.js';
import { keyBytes, type SubtleLike } from './decrypt.js';
import {
    PipelineError,
    decodeMaybeEncrypted,
    fetchBytes,
    fetchMaybeEncrypted,
} from './fetch.js';
import {
    absolutize,
    collectMasterRefs,
    hasAes128Key,
    isMasterPlaylistText,
    listSegmentUris,
    parseMasterText,
    substituteMasterRefs,
} from './playlist-text.js';
import { applyQualityCap, listQualities } from './quality-cap.js';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    rewriteMediaPlaylist,
} from './rewrite-media.js';

/** Angle id used when the master declares no `TYPE=VIDEO` rendition groups. */
export const DEFAULT_ANGLE_ID = 'default';

export interface PipelineContext {
    fetchImpl: typeof fetch;
    /** How munged text reaches the engine. */
    serveStrategy: ServeStrategy;
    /** Mirrors {@link AdapterCapabilities.keyDelivery}. */
    keyDelivery: 'memory' | 'url';
    keyHex?: string;
    signal?: AbortSignal;
    subtle?: SubtleLike;
    /** Raw decoded playlist text per absolute URL, for the current source. */
    cache: Map<string, string>;
}

/** Everything derived from a master playlist, before any narrowing. */
export interface MasterInfo {
    /** Absolute URL of the master. */
    url: string;
    /** Decoded text (decrypted when the object was LMCENC). */
    text: string;
    wasEncrypted: boolean;
    /** False when the URL actually served a media playlist. */
    isMaster: boolean;
    angles: Angle[];
    audioTracks: AudioTrack[];
    subtitleTracks: SubtitleTrack[];
    /** The master carries no video at all. */
    nativelyAudioOnly: boolean;
}

export interface MungeOptions {
    /** `null` → the master's default angle; {@link AUDIO_ONLY_ANGLE_ID} → audio only. */
    angleId: string | null;
    maxHeight?: number;
}

export interface MungeResult {
    source: AdapterSource;
    /** Post-cap renditions, as derived from the playlist text. */
    qualities: Quality[];
    isAudioOnly: boolean;
    /** The playlist text actually handed to the engine (specs assert on it). */
    masterText: string;
}

// ---------------------------------------------------------------------------
// Step 1–2: fetch + derive
// ---------------------------------------------------------------------------

export async function loadMaster(
    url: string,
    ctx: PipelineContext,
): Promise<MasterInfo> {
    const asset = await fetchMaybeEncrypted(url, {
        fetchImpl: ctx.fetchImpl,
        keyHex: ctx.keyHex,
        expect: 'playlist',
        signal: ctx.signal,
        subtle: ctx.subtle,
    });
    ctx.cache.set(url, asset.text);
    return describeMaster(url, asset.text, asset.wasEncrypted);
}

/** Pure derivation half of {@link loadMaster}; exported for fixture specs. */
export function describeMaster(
    url: string,
    text: string,
    wasEncrypted = false,
): MasterInfo {
    const isMaster = isMasterPlaylistText(text);
    if (!isMaster) {
        return {
            url,
            text,
            wasEncrypted,
            isMaster: false,
            angles: [],
            audioTracks: [],
            subtitleTracks: [],
            nativelyAudioOnly: false,
        };
    }

    const nativelyAudioOnly = isAudioOnlyMaster(text);
    const videoAngles = listVideoAngles(text).map<Angle>((angle) => ({
        id: angle.id,
        name: angle.name,
        isDefault: angle.isDefault,
    }));

    const angles: Angle[] = [...videoAngles];
    if (!nativelyAudioOnly && angles.length === 0) {
        angles.push({ id: DEFAULT_ANGLE_ID, name: 'Default', isDefault: true });
    }
    if (
        !nativelyAudioOnly &&
        angles.length > 0 &&
        hasAudioOnlyRendering(text)
    ) {
        angles.push({
            id: AUDIO_ONLY_ANGLE_ID,
            name: 'Audio only',
            isDefault: false,
        });
    }

    const parsed = parseMasterText(text);
    const audioTracks: AudioTrack[] = [];
    const subtitleTracks: SubtitleTrack[] = [];
    for (const entry of parsed.media) {
        if (entry.type === 'AUDIO') {
            audioTracks.push({
                id: masterTrackId(
                    'a',
                    entry.groupId,
                    entry.name,
                    entry.language,
                ),
                lang: entry.language,
                label: entry.name ?? entry.language ?? 'Audio',
            });
        } else if (entry.type === 'SUBTITLES') {
            subtitleTracks.push({
                id: masterTrackId(
                    'm',
                    entry.groupId,
                    entry.name,
                    entry.language,
                ),
                lang: entry.language,
                label: entry.name ?? entry.language ?? 'Subtitles',
                source: 'master',
            });
        }
    }

    return {
        url,
        text,
        wasEncrypted,
        isMaster: true,
        angles,
        audioTracks: dedupeById(audioTracks),
        subtitleTracks: dedupeById(subtitleTracks),
        nativelyAudioOnly,
    };
}

// ---------------------------------------------------------------------------
// Step 3–6: narrow, cap, rewrite, serve
// ---------------------------------------------------------------------------

export async function mungeSource(
    info: MasterInfo,
    options: MungeOptions,
    ctx: PipelineContext,
): Promise<MungeResult> {
    const narrowedText = narrow(info, options.angleId);
    const capped = applyQualityCap(narrowedText, options.maxHeight);
    const qualities = info.isMaster ? listQualities(capped) : [];
    const isAudioOnly =
        options.angleId === AUDIO_ONLY_ANGLE_ID ||
        info.nativelyAudioOnly ||
        (info.isMaster && isAudioOnlyMaster(capped));

    // Pass-through: nothing to hide, nothing to narrow.
    if (!ctx.keyHex && !info.wasEncrypted && capped === info.text) {
        await assertNoKeyRequired(info, ctx);
        return {
            source: { url: info.url, isBlob: false },
            qualities,
            isAudioOnly,
            masterText: capped,
        };
    }

    let keyUri: string | undefined;
    const resolveKeyUri = (): string | undefined => {
        if (!ctx.keyHex) return undefined;
        if (keyUri) return keyUri;
        keyUri =
            ctx.keyDelivery === 'memory'
                ? LUMINARY_KEY_PLACEHOLDER_URI
                : ctx.serveStrategy.serve(
                      keyBytes(ctx.keyHex),
                      KEY_CONTENT_TYPE,
                  );
        return keyUri;
    };

    let servedMasterText: string;
    if (!info.isMaster) {
        requireKeyFor(capped, info.url, ctx);
        servedMasterText = rewriteMediaPlaylist(capped, {
            playlistUrl: info.url,
            keyUri: hasAes128Key(capped) ? resolveKeyUri() : undefined,
        });
    } else {
        const replacements = new Map<string, string>();
        for (const ref of collectMasterRefs(capped)) {
            const absolute = absolutize(ref.uri, info.url);
            const text = await fetchPlaylistText(absolute, ctx);
            requireKeyFor(text, absolute, ctx);

            const segmentReplacements =
                ref.mediaType === 'SUBTITLES' && ctx.keyHex
                    ? await serveDecryptedVttSegments(text, absolute, ctx)
                    : undefined;

            const rewritten = rewriteMediaPlaylist(text, {
                playlistUrl: absolute,
                keyUri: hasAes128Key(text) ? resolveKeyUri() : undefined,
                segmentReplacements,
            });
            replacements.set(
                ref.uri,
                ctx.serveStrategy.serve(rewritten, PLAYLIST_CONTENT_TYPE),
            );
        }
        servedMasterText = substituteMasterRefs(capped, replacements);
    }

    const url = ctx.serveStrategy.serve(
        servedMasterText,
        PLAYLIST_CONTENT_TYPE,
    );
    return {
        source: {
            url,
            isBlob: true,
            ...(ctx.keyHex && ctx.keyDelivery === 'memory'
                ? { keyHex: ctx.keyHex }
                : {}),
        },
        qualities,
        isAudioOnly,
        masterText: servedMasterText,
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function narrow(info: MasterInfo, angleId: string | null): string {
    if (!info.isMaster) return info.text;
    if (angleId === AUDIO_ONLY_ANGLE_ID) {
        return buildAudioOnlyMaster(info.text) ?? info.text;
    }
    if (!angleId || angleId === DEFAULT_ANGLE_ID) return info.text;
    return extractAnglePlaylist(info.text, angleId);
}

async function fetchPlaylistText(
    url: string,
    ctx: PipelineContext,
): Promise<string> {
    const cached = ctx.cache.get(url);
    if (cached !== undefined) return cached;
    const asset = await fetchMaybeEncrypted(url, {
        fetchImpl: ctx.fetchImpl,
        keyHex: ctx.keyHex,
        expect: 'playlist',
        signal: ctx.signal,
        subtle: ctx.subtle,
    });
    ctx.cache.set(url, asset.text);
    return asset.text;
}

/**
 * The engine fetches a SUBTITLES playlist's `.vtt` segments itself and cannot
 * decrypt LMCENC, so encrypted ones are decrypted here and served as plaintext.
 * Plaintext ones are left alone (the rewrite absolutizes them). VOD only —
 * the segment list is finite.
 */
async function serveDecryptedVttSegments(
    playlistText: string,
    playlistUrl: string,
    ctx: PipelineContext,
): Promise<Map<string, string>> {
    const replacements = new Map<string, string>();
    for (const uri of listSegmentUris(playlistText)) {
        const absolute = absolutize(uri, playlistUrl);
        if (replacements.has(absolute)) continue;
        const bytes = await fetchBytes(absolute, ctx);
        if (!isEncryptedPayload(bytes)) continue;
        const asset = await decodeMaybeEncrypted(bytes, absolute, {
            keyHex: ctx.keyHex,
            expect: 'vtt',
            subtle: ctx.subtle,
        });
        replacements.set(
            absolute,
            ctx.serveStrategy.serve(asset.text, VTT_CONTENT_TYPE),
        );
    }
    return replacements;
}

function requireKeyFor(
    playlistText: string,
    url: string,
    ctx: PipelineContext,
): void {
    if (ctx.keyHex || !hasAes128Key(playlistText)) return;
    throw new PipelineError(
        'key-required',
        `${url} declares AES-128 segments but no session key was supplied`,
        { url },
    );
}

/**
 * Best-effort key check for the pass-through path.
 *
 * A master that needs no munging is never rewritten, so its media playlists are
 * never read — yet they may still declare `METHOD=AES-128`. One cheap probe of
 * the first referenced playlist (cached; the engine fetches it next anyway)
 * turns that into a fail-fast `key-required` instead of an opaque engine error.
 * Probe failures are ignored: they must not break an otherwise fine load.
 */
async function assertNoKeyRequired(
    info: MasterInfo,
    ctx: PipelineContext,
): Promise<void> {
    if (!info.isMaster) {
        requireKeyFor(info.text, info.url, ctx);
        return;
    }
    const first = collectMasterRefs(info.text)[0];
    if (!first) return;

    const absolute = absolutize(first.uri, info.url);
    let text: string;
    try {
        text = await fetchPlaylistText(absolute, ctx);
    } catch (error) {
        if (error instanceof PipelineError && error.code === 'key-required') {
            throw error;
        }
        return;
    }
    requireKeyFor(text, absolute, ctx);
}

function masterTrackId(
    prefix: string,
    groupId: string | undefined,
    name: string | undefined,
    language: string | undefined,
): string {
    return `${prefix}:${groupId ?? ''}:${name ?? language ?? ''}`;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}
