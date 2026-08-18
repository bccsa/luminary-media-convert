/**
 * Sidecar loading — chapters, out-of-band subtitles, and scrub thumbnails.
 *
 * Both go through {@link fetchMaybeEncrypted}, so an LMCENC sidecar is
 * decrypted with the session key and a plaintext one passes straight through.
 * Multi-lingual is the default shape: each language is fetched, decrypted and
 * parsed only when its track is activated, then cached for the rest of the
 * source's life. Implementing apps that only have one language just pass one
 * entry and never notice.
 */

import type {
    AdapterTextTrack,
    Chapter,
    ChapterSidecar,
    ChapterTrack,
    ServeStrategy,
    SubtitleSidecar,
    SubtitleTrack,
    ThumbnailSidecar,
} from './types.js';
import {
    parseThumbnailVtt,
    type ThumbnailSpriteCue,
} from '@luminary-media-converter/hls-core';
import { VTT_CONTENT_TYPE } from './pipeline/blob-registry.js';
import { fetchMaybeEncrypted } from './pipeline/fetch.js';
import type { SubtleLike } from './pipeline/decrypt.js';
import { parseVttCues } from './vtt.js';

/** Stable id of the chapter track for `lang`. */
export function chapterTrackId(lang: string): string {
    return `c:${lang}`;
}

/** Stable id of the subtitle track for a sidecar `lang`. */
export function subtitleSidecarId(lang: string): string {
    return `s:${lang}`;
}

/**
 * Pick the chapter track to start on: the one matching the active audio
 * language, else the first. Returns null when there are no chapter tracks.
 */
export function pickDefaultChapterTrack(
    tracks: ChapterTrack[],
    audioLang?: string,
): string | null {
    if (tracks.length === 0) return null;
    if (audioLang) {
        const base = baseLang(audioLang);
        const match = tracks.find((track) => baseLang(track.lang) === base);
        if (match) return match.id;
    }
    return tracks[0]?.id ?? null;
}

function baseLang(lang: string): string {
    return lang.toLowerCase().split(/[-_]/)[0] ?? lang.toLowerCase();
}

export interface SidecarLoaderOptions {
    fetchImpl: typeof fetch;
    serveStrategy: ServeStrategy;
    keyHex?: string;
    signal?: AbortSignal;
    subtle?: SubtleLike;
}

export class SidecarLoader {
    private chapterSources: ChapterSidecar[] = [];
    private readonly chapterCache = new Map<string, Chapter[]>();

    constructor(private readonly options: SidecarLoaderOptions) {}

    /** Replace the sidecar set (a new source generation). Clears the cache. */
    setChapters(sidecars: ChapterSidecar[] | undefined): void {
        this.chapterSources = dedupeByLang(sidecars ?? []);
        this.chapterCache.clear();
    }

    chapterTracks(): ChapterTrack[] {
        return this.chapterSources.map((sidecar) => ({
            id: chapterTrackId(sidecar.lang),
            lang: sidecar.lang,
            label: sidecar.label ?? sidecar.lang,
        }));
    }

    /**
     * Cues of one chapter track, fetched + decrypted + parsed on first use and
     * cached afterwards. Unknown ids yield `[]`.
     */
    /**
     * The scrub-preview cues, or an empty list when there are none to have.
     *
     * Every failure is an empty list rather than a throw: no sidecar passed, a
     * 404 because the session was encoded with `thumbnails: false`, an
     * audio-only encode, a VTT that will not parse. None of those is something a
     * viewer can act on, and all of them mean the same thing on screen — no
     * preview — so the caller gets one answer to handle instead of four.
     *
     * Cues come back in start order, which {@link findThumbnailCue} relies on
     * for its binary search.
     */
    async loadThumbnails(
        sidecar: ThumbnailSidecar | undefined,
    ): Promise<ThumbnailSpriteCue[]> {
        if (!sidecar?.url) return [];
        try {
            const asset = await fetchMaybeEncrypted(sidecar.url, {
                fetchImpl: this.options.fetchImpl,
                keyHex: this.options.keyHex,
                expect: 'vtt',
                signal: this.options.signal,
                subtle: this.options.subtle,
            });
            // Sprite paths in the VTT are relative to the VTT's own directory.
            const baseUrl = sidecar.url.slice(0, sidecar.url.lastIndexOf('/'));
            return parseThumbnailVtt(asset.text, baseUrl);
        } catch {
            return [];
        }
    }

    async loadChapters(trackId: string): Promise<Chapter[]> {
        const cached = this.chapterCache.get(trackId);
        if (cached) return cached;

        const sidecar = this.chapterSources.find(
            (entry) => chapterTrackId(entry.lang) === trackId,
        );
        if (!sidecar) return [];

        const asset = await fetchMaybeEncrypted(sidecar.url, {
            fetchImpl: this.options.fetchImpl,
            keyHex: this.options.keyHex,
            expect: 'vtt',
            signal: this.options.signal,
            subtle: this.options.subtle,
        });
        const cues = parseVttCues(asset.text);
        this.chapterCache.set(trackId, cues);
        return cues;
    }

    /**
     * Sidecar subtitles as engine-ready text tracks: fetched, decrypted and
     * served as plaintext WebVTT. Subtitles declared inside the master travel
     * with the munged playlist and are not touched here.
     */
    async loadSubtitleTracks(
        sidecars: SubtitleSidecar[] | undefined,
    ): Promise<{ tracks: SubtitleTrack[]; adapterTracks: AdapterTextTrack[] }> {
        const tracks: SubtitleTrack[] = [];
        const adapterTracks: AdapterTextTrack[] = [];

        for (const sidecar of dedupeByLang(sidecars ?? [])) {
            const asset = await fetchMaybeEncrypted(sidecar.url, {
                fetchImpl: this.options.fetchImpl,
                keyHex: this.options.keyHex,
                expect: 'vtt',
                signal: this.options.signal,
                subtle: this.options.subtle,
            });
            const id = subtitleSidecarId(sidecar.lang);
            tracks.push({
                id,
                lang: sidecar.lang,
                label: sidecar.label,
                source: 'sidecar',
            });
            adapterTracks.push({
                id,
                lang: sidecar.lang,
                label: sidecar.label,
                blobUrl: this.options.serveStrategy.serve(
                    asset.text,
                    VTT_CONTENT_TYPE,
                ),
            });
        }

        return { tracks, adapterTracks };
    }
}

function dedupeByLang<T extends { lang: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(item.lang)) return false;
        seen.add(item.lang);
        return true;
    });
}
