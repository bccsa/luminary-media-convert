/**
 * The munging pipeline.
 *
 * Fetch master → derive angles/qualities/tracks → extract the requested angle →
 * cap quality → rewrite + serve the media playlists → serve the master → hand
 * the result to the adapter. EVERY source takes that path, encrypted or not,
 * narrowed or not: the media playlists it reads on the way are the same ones
 * the engine was about to fetch anyway, and having them in hand is what lets
 * the wrapper reason about the output (chunk boundaries for prefetch, key
 * requirements, absolutized segment URIs) instead of guessing.
 */

import {
    extractAnglePlaylist,
    isEncryptedPayload,
    listAngles,
} from '@luminary-media-converter/hls-core';
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
    canRenderAudioOnly,
    isAudioOnlyMaster,
} from './audio-only.js';
import {
    KEY_CONTENT_TYPE,
    PLAYLIST_CONTENT_TYPE,
    VTT_CONTENT_TYPE,
} from './content-types.js';
import { describeLiveness, type LivePlaylistSpec } from '../policy/live.js';
import { keyBytes, type SubtleLike } from './decrypt.js';
import {
    PipelineError,
    decodeMaybeEncrypted,
    fetchBytes,
    fetchMaybeEncrypted,
} from './fetch.js';
import {
    absolutize,
    anchorToDocument,
    collectMasterRefs,
    hasAes128Key,
    isMasterModel,
    listSegmentUris,
    masterHasVideo,
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

/** One media playlist read while munging, as it was before the rewrite. */
export interface MungedMediaPlaylist {
    /** Absolute URL the playlist was fetched from; relative URIs resolve against it. */
    url: string;
    /** `VIDEO` for a variant reference, else the `#EXT-X-MEDIA` `TYPE`. */
    mediaType: string;
    /** Decoded text: post-LMCENC-decryption, pre-rewrite. */
    text: string;
}

/**
 * A munged source, short of the one thing the pipeline does not own: the
 * recovery policy the controller resolves and the adapter's ladder runs on.
 * The controller completes it at the point of attach.
 */
export type MungedSource = Omit<AdapterSource, 'recovery'>;

export interface MungeResult {
    source: MungedSource;
    /**
     * At least one media playlist is still being written (no `#EXT-X-ENDLIST`),
     * so the source has to be re-read for as long as it plays. Byte-range chunk
     * warming is meaningless for such a source and disables itself.
     */
    isLive: boolean;
    /** Post-cap renditions, as derived from the playlist text. */
    qualities: Quality[];
    isAudioOnly: boolean;
    /** The playlist text actually handed to the engine (specs assert on it). */
    masterText: string;
    /**
     * Every media playlist this munge read, for consumers that need the segment
     * layout rather than the engine-facing text — chunk prefetch, today. Empty
     * when nothing was fetched.
     */
    mediaPlaylists: MungedMediaPlaylist[];
}

// ---------------------------------------------------------------------------
// Step 1–2: fetch + derive
// ---------------------------------------------------------------------------

export async function loadMaster(
    url: string,
    ctx: PipelineContext,
): Promise<MasterInfo> {
    // Everything read from here on resolves against this URL, so it is made
    // absolute once rather than on every URI that needs it.
    const absolute = anchorToDocument(url);
    const asset = await fetchMaybeEncrypted(absolute, {
        fetchImpl: ctx.fetchImpl,
        keyHex: ctx.keyHex,
        expect: 'playlist',
        signal: ctx.signal,
        subtle: ctx.subtle,
    });
    ctx.cache.set(absolute, asset.text);
    return describeMaster(absolute, asset.text, asset.wasEncrypted);
}

/** Pure derivation half of {@link loadMaster}; exported for fixture specs. */
export function describeMaster(
    url: string,
    text: string,
    wasEncrypted = false,
): MasterInfo {
    // Parsed once, and every question below asked of the one model. It was
    // five parses, one of them building a whole audio-only master only to
    // compare it with null.
    const parsed = parseMasterText(text);
    const { master } = parsed;

    if (!isMasterModel(master)) {
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

    const nativelyAudioOnly = !masterHasVideo(master);
    const videoAngles = listAngles(master).map<Angle>((angle) => ({
        id: angle.id,
        name: angle.name,
        isDefault: angle.isDefault,
    }));

    const angles: Angle[] = [...videoAngles];
    if (!nativelyAudioOnly && angles.length === 0) {
        angles.push({ id: DEFAULT_ANGLE_ID, name: 'Default', isDefault: true });
    }
    if (!nativelyAudioOnly && angles.length > 0 && canRenderAudioOnly(master)) {
        angles.push({
            id: AUDIO_ONLY_ANGLE_ID,
            name: 'Audio only',
            isDefault: false,
        });
    }

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

    const mediaPlaylists: MungedMediaPlaylist[] = [];
    let isLive = false;

    /**
     * Hand a live playlist to the serving layer, which owns keeping it fresh.
     *
     * Returns the URL to serve it from, or throws when the strategy cannot do
     * the job. Refusing is the point: served statically, a live playlist would
     * play its first snapshot and then sit at the end of it forever, which
     * looks like playback and is not.
     */
    const serveLivePlaylist = (url: string, text: string): string => {
        const { targetDurationSec } = describeLiveness(text);
        const spec: LivePlaylistSpec = {
            url,
            baseUrl: url,
            ...(ctx.keyHex
                ? { keyUri: resolveKeyUri(), keyBytes: keyBytes(ctx.keyHex) }
                : {}),
            refreshSec: targetDurationSec,
        };
        const served = ctx.serveStrategy.serveLive?.(spec);
        if (!served) {
            throw new PipelineError(
                'live-unsupported',
                `${url} is still being written (no #EXT-X-ENDLIST) and this ` +
                    'player cannot refresh a live playlist',
                { url },
            );
        }
        return served;
    };

    let servedMasterText: string;
    if (!info.isMaster) {
        requireKeyFor(capped, info.url, ctx);
        // The URL served a media playlist directly — it IS the only stream, so
        // it counts as video for anything reading the list back.
        mediaPlaylists.push({
            url: info.url,
            mediaType: 'VIDEO',
            text: capped,
        });
        if (describeLiveness(capped).isLive) {
            isLive = true;
            // Nothing to serve as a master: the live URL IS the source.
            return {
                source: {
                    url: serveLivePlaylist(info.url, capped),
                    isBlob: true,
                    ...(ctx.keyHex && ctx.keyDelivery === 'memory'
                        ? { keyHex: ctx.keyHex }
                        : {}),
                },
                qualities,
                isAudioOnly,
                masterText: capped,
                mediaPlaylists,
                isLive,
            };
        }
        servedMasterText = rewriteMediaPlaylist(capped, {
            playlistUrl: info.url,
            keyUri: hasAes128Key(capped) ? resolveKeyUri() : undefined,
        });
    } else {
        const replacements = new Map<string, string>();
        const refs = collectMasterRefs(capped).map((ref) => ({
            ref,
            absolute: absolutize(ref.uri, info.url),
        }));
        // Every read starts here, at once; the loop consumes them in master
        // order. None depends on another, and reading them one after another
        // put a round trip per playlist in front of playback — twenty on a
        // multi-language live ladder. Consuming in order keeps everything
        // observable as it was: which failure is reported when several reads
        // fail, the order of `mediaPlaylists`, and the order the strategy is
        // asked to serve in.
        const reads = startPlaylistReads(
            refs.map(({ absolute }) => absolute),
            ctx,
        );
        for (const { ref, absolute } of refs) {
            const text = await reads.get(absolute)!;
            requireKeyFor(text, absolute, ctx);
            mediaPlaylists.push({
                url: absolute,
                mediaType: ref.mediaType ?? 'VIDEO',
                text,
            });

            if (describeLiveness(text).isLive) {
                isLive = true;
                replacements.set(ref.uri, serveLivePlaylist(absolute, text));
                continue;
            }

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
        mediaPlaylists,
        isLive,
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
 * Start reading every URL at once, one read per distinct URL, and return the
 * pending reads by URL for the caller to await in the order it needs.
 *
 * Each read is marked handled as it starts. The caller awaits them one at a
 * time, so a read that fails before its turn would otherwise surface as an
 * unhandled rejection — and once an earlier read has thrown, its turn never
 * comes at all.
 */
function startPlaylistReads(
    urls: readonly string[],
    ctx: PipelineContext,
): Map<string, Promise<string>> {
    const reads = new Map<string, Promise<string>>();
    for (const url of urls) {
        if (reads.has(url)) continue;
        const read = fetchPlaylistText(url, ctx);
        void read.catch(() => undefined);
        reads.set(url, read);
    }
    return reads;
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
