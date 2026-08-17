/**
 * Chunk warming — the schedule half.
 *
 * Byte-range output packs many segments into a few large chunk objects, all
 * renditions of one angle sharing a chain and all audio groups sharing another.
 * A delivery edge that forwards a requested range immediately while backhauling
 * the whole object behind it makes the first request for a chunk the slow one:
 * the moment the engine's buffer crosses into chunk N+1, that object may not be
 * at the edge yet. So a few kilobytes of the next chunk are requested slightly
 * before the crossing, which starts the backhaul while the engine is still busy
 * with the current one.
 *
 * The schedule math lives here because it is a property of the OUTPUT, not of
 * any engine: every adapter reading the same chains needs the same boundaries,
 * and `buildChunkSchedules` is pure — its result is plain data that serializes
 * across a native bridge unchanged.
 *
 * The warming LOOP is not here. Pacing a ticker against a media element's
 * buffer front is platform work — a JS interval is throttled or suspended once
 * the app is backgrounded, precisely when a native player keeps playing — so it
 * belongs to the adapter, specified by `PlayerAdapter.warmChunks` and
 * implemented for the web in `player-web/src/adapter/chunkWarming.ts`.
 * `docs/chunk-warming.md` is the porting guide.
 */

import { parseMediaPlaylist } from '@luminary-media-converter/hls';
import { absolutize } from './pipeline/playlist-text.js';
import type { MungeResult } from './pipeline/pipeline.js';

/**
 * Lead time, in seconds of buffer, before a boundary is warmed.
 *
 * Generous on purpose: a cap-sized chunk on a slow backhaul can take tens of
 * seconds to land at the edge in full, and eviction between warm and use is
 * not a real risk at this horizon — edges evict over hours, not seconds. The
 * cost of leading long is an occasional backhaul for a boundary the viewer
 * never reaches, bounded by how few chunk objects an asset has. Note the
 * watermark is the buffer front, which runs ahead of the playhead by the
 * engine's buffer length — the viewer is further away than this number reads.
 */
export const DEFAULT_LEAD_SECONDS = 60;
/** How much of the next chunk to request. Enough to start a backhaul. */
export const DEFAULT_WARM_BYTES = 65_536;

/** One contiguous run of segments sharing a chunk object. */
export interface ChunkBoundary {
    /** Absolute URL of the chunk object. */
    url: string;
    /** Media time the run starts at, in seconds. */
    start: number;
    /** Media time the run ends at, in seconds. */
    end: number;
}

/**
 * Turn the munge's media playlists into one boundary schedule per chunk chain.
 *
 * Playlists whose segments carry no `#EXT-X-BYTERANGE` are skipped: there are
 * no shared objects to warm, so prefetch disables itself on anything but
 * byte-range output rather than issuing pointless requests.
 *
 * Chains are deduped by their first chunk URL. Every rendition of an angle
 * references the same chunk files, so one schedule covers all of them — and the
 * URLs say so, which is why no name parsing is needed to work out what belongs
 * to which angle.
 */
export function buildChunkSchedules(
    mediaPlaylists: MungeResult['mediaPlaylists'],
): ChunkBoundary[][] {
    const byChain = new Map<string, ChunkBoundary[]>();

    for (const playlist of mediaPlaylists) {
        const segments = parseMediaPlaylist(playlist.text).segments;
        if (!segments.some((segment) => segment.byteRange)) continue;

        const boundaries: ChunkBoundary[] = [];
        let elapsed = 0;
        for (const segment of segments) {
            const url = absolutize(segment.uri, playlist.url);
            const last = boundaries.at(-1);
            if (last && last.url === url) {
                last.end = elapsed + segment.duration;
            } else {
                boundaries.push({
                    url,
                    start: elapsed,
                    end: elapsed + segment.duration,
                });
            }
            elapsed += segment.duration;
        }

        const first = boundaries[0];
        if (!first || byChain.has(first.url)) continue;
        byChain.set(first.url, boundaries);
    }

    return [...byChain.values()];
}
