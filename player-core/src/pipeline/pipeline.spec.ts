import { describe, expect, it } from 'vitest';
import { AUDIO_ONLY_ANGLE_ID } from '../types.js';
import {
    DEFAULT_ANGLE_ID,
    describeMaster,
    loadMaster,
    mungeSource,
    type PipelineContext,
} from './pipeline.js';
import { KEY_CONTENT_TYPE } from './content-types.js';
import { keyBytes } from './decrypt.js';
import { LUMINARY_KEY_PLACEHOLDER_URI } from './rewrite-media.js';
import { parseMasterText } from './playlist-text.js';
import {
    AUDIO_ONLY_MASTER,
    CHAPTERS_VTT,
    ENCRYPTED_MEDIA_PLAYLIST,
    FakeLiveServeStrategy,
    FakeServeStrategy,
    LIVE_MEDIA_PLAYLIST,
    MULTI_ANGLE_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
    SUBTITLE_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    encryptLmcenc,
    flush,
    makeDeferredFetch,
    makeFetch,
} from '../test-support/index.js';

const BASE = 'https://cdn.example.com/out/session';
const MASTER_URL = `${BASE}/master.m3u8`;

function context(
    routes: Record<string, string | Uint8Array | { status: number }>,
    overrides: Partial<PipelineContext> = {},
): PipelineContext & { serve: FakeServeStrategy; calls: string[] } {
    const { fetchImpl, calls } = makeFetch(routes);
    const serve = new FakeServeStrategy();
    return {
        fetchImpl,
        serveStrategy: serve,
        keyDelivery: 'memory',
        cache: new Map(),
        ...overrides,
        serve,
        calls,
    };
}

const multiAngleRoutes = {
    [MASTER_URL]: MULTI_ANGLE_MASTER,
    [`${BASE}/angle0_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle0_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/angle1_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/audio_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    [`${BASE}/subs_en/playlist.m3u8`]: SUBTITLE_MEDIA_PLAYLIST,
};

describe('describeMaster', () => {
    it('derives angles, the audio-only pseudo-angle and tracks', () => {
        const info = describeMaster(MASTER_URL, MULTI_ANGLE_MASTER);
        expect(info.angles.map((a) => a.id)).toEqual([
            'angle_0',
            'angle_1',
            AUDIO_ONLY_ANGLE_ID,
        ]);
        expect(info.angles[0]?.isDefault).toBe(true);
        expect(info.audioTracks).toHaveLength(1);
        expect(info.subtitleTracks[0]).toMatchObject({
            lang: 'en',
            source: 'master',
        });
        expect(info.nativelyAudioOnly).toBe(false);
    });

    it('synthesizes a Default angle for a single-angle master', () => {
        const info = describeMaster(MASTER_URL, SIMPLE_MASTER);
        expect(info.angles.map((a) => a.id)).toEqual([
            DEFAULT_ANGLE_ID,
            AUDIO_ONLY_ANGLE_ID,
        ]);
    });

    it('offers no angles at all for a natively audio-only master', () => {
        const info = describeMaster(MASTER_URL, AUDIO_ONLY_MASTER);
        expect(info.angles).toEqual([]);
        expect(info.nativelyAudioOnly).toBe(true);
    });

    it('recognizes a bare media playlist', () => {
        const info = describeMaster(MASTER_URL, PLAIN_MEDIA_PLAYLIST);
        expect(info.isMaster).toBe(false);
        expect(info.angles).toEqual([]);
    });
});

describe('mungeSource — plain sources take the full path too', () => {
    const plainRoutes = {
        [MASTER_URL]: SIMPLE_MASTER,
        [`${BASE}/stream_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/stream_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/stream_480/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
    };

    it('serves an unencrypted, un-narrowed master rather than passing its URL through', async () => {
        const ctx = context(plainRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );

        expect(result.source.isBlob).toBe(true);
        expect(result.source.url).not.toBe(MASTER_URL);
        expect(ctx.serve.textOf(result.source.url)).toBe(result.masterText);
        expect(result.qualities.map((q) => q.id)).toEqual([
            '1080',
            '720',
            '480',
        ]);
    });

    it('reports every media playlist it read, absolute and decoded', async () => {
        const ctx = context(plainRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );

        expect(result.mediaPlaylists.map((p) => p.url)).toEqual([
            `${BASE}/stream_1080/playlist.m3u8`,
            `${BASE}/stream_720/playlist.m3u8`,
            `${BASE}/stream_480/playlist.m3u8`,
            `${BASE}/audio_hi_128kbps/playlist.m3u8`,
            `${BASE}/audio_lo_64kbps/playlist.m3u8`,
        ]);
        expect(result.mediaPlaylists.map((p) => p.mediaType)).toEqual([
            'VIDEO',
            'VIDEO',
            'VIDEO',
            'AUDIO',
            'AUDIO',
        ]);
        // Pre-rewrite text: the segment URI is still relative to its playlist.
        expect(result.mediaPlaylists[0]?.text).toBe(PLAIN_MEDIA_PLAYLIST);
    });

    it('hands back the DECRYPTED text of an LMCENC media playlist', async () => {
        const ctx = context(
            {
                [MASTER_URL]: AUDIO_ONLY_MASTER,
                [`${BASE}/audio_128kbps/playlist.m3u8`]: encryptLmcenc(
                    ENCRYPTED_MEDIA_PLAYLIST,
                ),
            },
            { keyHex: TEST_KEY_HEX },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        expect(result.mediaPlaylists).toHaveLength(1);
        expect(result.mediaPlaylists[0]?.text).toBe(ENCRYPTED_MEDIA_PLAYLIST);
    });

    it('fails fast with key-required when the media playlists are AES-128', async () => {
        const ctx = context({
            [MASTER_URL]: SIMPLE_MASTER,
            [`${BASE}/stream_1080/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
        });
        const info = await loadMaster(MASTER_URL, ctx);
        await expect(
            mungeSource(info, { angleId: DEFAULT_ANGLE_ID }, ctx),
        ).rejects.toMatchObject({ code: 'key-required' });
    });

    it('is loud about an unreachable sub-playlist, plain source or not', async () => {
        const ctx = context({ [MASTER_URL]: SIMPLE_MASTER });
        const info = await loadMaster(MASTER_URL, ctx);
        await expect(
            mungeSource(info, { angleId: DEFAULT_ANGLE_ID }, ctx),
        ).rejects.toMatchObject({ code: 'fetch-failed' });
    });
});

describe('mungeSource — narrowing', () => {
    it('pins one angle and serves every sub-playlist', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: 'angle_0' }, ctx);

        expect(result.source.isBlob).toBe(true);
        expect(result.masterText).not.toContain('angle1_1080');
        // 2 variants + audio + subtitles playlists, then the master itself.
        expect(ctx.serve.served).toHaveLength(5);
        expect(ctx.serve.textOf(result.source.url)).toBe(result.masterText);
    });

    it('absolutizes sub-playlist segments against their own URL', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: 'angle_0' }, ctx);

        const variantUrl = parseMasterText(result.masterText).variants[0]!.uri;
        expect(ctx.serve.textOf(variantUrl)).toContain(
            `${BASE}/angle0_1080/segment_0.m4s`,
        );
    });

    it('applies the quality cap before serving', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: 'angle_0', maxHeight: 720 },
            ctx,
        );
        expect(result.qualities.map((q) => q.id)).toEqual(['720']);
        expect(result.masterText).not.toContain('1080');
        // 1080p's playlist is never even fetched.
        expect(ctx.calls).not.toContain(`${BASE}/angle0_1080/playlist.m3u8`);
    });

    it('serves an audio-only master with no video playlist in it', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: AUDIO_ONLY_ANGLE_ID },
            ctx,
        );

        expect(result.isAudioOnly).toBe(true);
        for (const call of ctx.calls) expect(call).not.toContain('angle0_');
        for (const call of ctx.calls) expect(call).not.toContain('angle1_');
        expect(parseMasterText(result.masterText).variants).toHaveLength(1);
    });

    it('is loud about a sub-playlist that fails to load', async () => {
        const ctx = context({
            ...multiAngleRoutes,
            [`${BASE}/angle0_720/playlist.m3u8`]: { status: 500 },
        });
        const info = await loadMaster(MASTER_URL, ctx);
        await expect(
            mungeSource(info, { angleId: 'angle_0' }, ctx),
        ).rejects.toMatchObject({ code: 'fetch-failed' });
    });
});

describe('mungeSource — key delivery', () => {
    const encryptedRoutes = {
        [MASTER_URL]: SIMPLE_MASTER,
        [`${BASE}/stream_1080/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
        [`${BASE}/stream_720/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
        [`${BASE}/stream_480/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
        [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
        [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: ENCRYPTED_MEDIA_PLAYLIST,
    };

    it("mints NO key blob for a 'memory' adapter and passes keyHex instead", async () => {
        const ctx = context(encryptedRoutes, {
            keyHex: TEST_KEY_HEX,
            keyDelivery: 'memory',
        });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );

        expect(ctx.serve.contentTypes()).not.toContain(KEY_CONTENT_TYPE);
        expect(result.source.keyHex).toBe(TEST_KEY_HEX);
        // Nothing key-shaped in the playlist text either — just the sentinel.
        for (const item of ctx.serve.served) {
            expect(String(item.content)).not.toContain(TEST_KEY_HEX);
        }
        const variantUrl = parseMasterText(result.masterText).variants[0]!.uri;
        expect(ctx.serve.textOf(variantUrl)).toContain(
            `URI="${LUMINARY_KEY_PLACEHOLDER_URI}"`,
        );
    });

    it("serves raw key bytes for a 'url' adapter and rewrites to that URL", async () => {
        const ctx = context(encryptedRoutes, {
            keyHex: TEST_KEY_HEX,
            keyDelivery: 'url',
        });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );

        const keyItem = ctx.serve.served.find(
            (item) => item.contentType === KEY_CONTENT_TYPE,
        );
        expect(keyItem).toBeDefined();
        expect(keyItem!.content).toBeInstanceOf(Uint8Array);
        expect((keyItem!.content as Uint8Array).length).toBe(16);
        // Exactly one key is served, however many playlists reference it.
        expect(
            ctx.serve.served.filter(
                (item) => item.contentType === KEY_CONTENT_TYPE,
            ),
        ).toHaveLength(1);
        expect(result.source.keyHex).toBeUndefined();

        const variantUrl = parseMasterText(result.masterText).variants[0]!.uri;
        expect(ctx.serve.textOf(variantUrl)).toContain(`URI="${keyItem!.url}"`);
    });

    it('serves no key at all when the playlists are not encrypted', async () => {
        const ctx = context(
            {
                ...multiAngleRoutes,
                [`${BASE}/subs_en/en_0.vtt`]: CHAPTERS_VTT,
            },
            { keyHex: TEST_KEY_HEX, keyDelivery: 'url' },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        await mungeSource(info, { angleId: 'angle_0' }, ctx);
        expect(ctx.serve.contentTypes()).not.toContain(KEY_CONTENT_TYPE);
    });

    it('decrypts an LMCENC master and its LMCENC media playlists', async () => {
        const ctx = context(
            {
                [MASTER_URL]: encryptLmcenc(AUDIO_ONLY_MASTER),
                [`${BASE}/audio_128kbps/playlist.m3u8`]: encryptLmcenc(
                    ENCRYPTED_MEDIA_PLAYLIST,
                ),
            },
            { keyHex: TEST_KEY_HEX },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        expect(info.wasEncrypted).toBe(true);

        const result = await mungeSource(info, { angleId: null }, ctx);
        expect(result.isAudioOnly).toBe(true);
        expect(result.source.isBlob).toBe(true);
        expect(result.masterText).toContain('#EXT-X-STREAM-INF');
    });
});

describe('mungeSource — subtitle VTT segments', () => {
    it('decrypts LMCENC .vtt segments and serves them as plaintext', async () => {
        const ctx = context(
            {
                ...multiAngleRoutes,
                [`${BASE}/subs_en/en_0.vtt`]: encryptLmcenc(CHAPTERS_VTT),
            },
            { keyHex: TEST_KEY_HEX },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: 'angle_0' }, ctx);

        const served = ctx.serve.served.find(
            (item) => item.contentType === 'text/vtt',
        );
        expect(served?.content).toBe(CHAPTERS_VTT);

        const subsUri = parseMasterText(result.masterText).media.find(
            (m) => m.type === 'SUBTITLES',
        )?.uri;
        expect(ctx.serve.textOf(subsUri!)).toContain(served!.url);
    });

    it('merely absolutizes plaintext .vtt segments', async () => {
        const ctx = context(
            {
                ...multiAngleRoutes,
                [`${BASE}/subs_en/en_0.vtt`]: CHAPTERS_VTT,
            },
            { keyHex: TEST_KEY_HEX },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: 'angle_0' }, ctx);

        expect(ctx.serve.contentTypes()).not.toContain('text/vtt');
        const subsUri = parseMasterText(result.masterText).media.find(
            (m) => m.type === 'SUBTITLES',
        )?.uri;
        expect(ctx.serve.textOf(subsUri!)).toContain(
            `${BASE}/subs_en/en_0.vtt`,
        );
    });

    it('does not touch subtitle segments when there is no session key', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        await mungeSource(info, { angleId: 'angle_0' }, ctx);
        expect(ctx.calls).not.toContain(`${BASE}/subs_en/en_0.vtt`);
    });
});

describe('mungeSource — caching', () => {
    it('reads each playlist once across repeated munges (setAngle)', async () => {
        const ctx = context(multiAngleRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        await mungeSource(info, { angleId: 'angle_0' }, ctx);
        const afterFirst = ctx.calls.length;
        await mungeSource(info, { angleId: 'angle_1' }, ctx);

        // angle_1's playlist is the only new fetch.
        expect(ctx.calls.length).toBe(afterFirst + 1);
        expect(ctx.calls.at(-1)).toBe(`${BASE}/angle1_1080/playlist.m3u8`);
    });
});

/**
 * `context()` over a serving layer that can refresh live playlists — the
 * capability a live source needs, and the one `FakeServeStrategy` lacks.
 */
function liveContext(
    routes: Record<string, string | Uint8Array | { status: number }>,
    overrides: Partial<PipelineContext> = {},
) {
    const serve = new FakeLiveServeStrategy();
    return { ...context(routes, overrides), serveStrategy: serve, serve };
}

describe('mungeSource — live sources', () => {
    const VARIANTS = ['stream_1080', 'stream_720', 'stream_480'].map(
        (dir) => `${BASE}/${dir}/playlist.m3u8`,
    );
    const AUDIO = ['audio_hi_128kbps', 'audio_lo_64kbps'].map(
        (dir) => `${BASE}/${dir}/playlist.m3u8`,
    );
    const everyPlaylist = (text: string) =>
        Object.fromEntries([...VARIANTS, ...AUDIO].map((url) => [url, text]));
    const liveRoutes = {
        [MASTER_URL]: SIMPLE_MASTER,
        ...everyPlaylist(LIVE_MEDIA_PLAYLIST),
    };
    /** The encoder's AES-128 fixture, still being written. */
    const LIVE_ENCRYPTED = ENCRYPTED_MEDIA_PLAYLIST.replace(
        '#EXT-X-ENDLIST\n',
        '',
    );

    it('refuses a live source when the serving layer cannot refresh a playlist', async () => {
        // Served statically, a live playlist plays its first snapshot and then
        // sits at the end of it — which looks like playback and is not.
        const ctx = context(liveRoutes);
        const info = await loadMaster(MASTER_URL, ctx);

        await expect(
            mungeSource(info, { angleId: null }, ctx),
        ).rejects.toMatchObject({ code: 'live-unsupported', url: VARIANTS[0] });
    });

    it('refuses a bare live media playlist the same way', async () => {
        const ctx = context({ [MASTER_URL]: LIVE_MEDIA_PLAYLIST });
        const info = await loadMaster(MASTER_URL, ctx);

        await expect(
            mungeSource(info, { angleId: null }, ctx),
        ).rejects.toMatchObject({ code: 'live-unsupported' });
    });

    it('hands each live playlist to serveLive and points the master at what it returns', async () => {
        const ctx = liveContext(liveRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        expect(result.isLive).toBe(true);
        expect(ctx.serve.liveSpecs.map((spec) => spec.url)).toEqual([
            ...VARIANTS,
            ...AUDIO,
        ]);
        const master = parseMasterText(result.masterText);
        expect(master.variants.map((variant) => variant.uri)).toEqual([
            'fake:live/1',
            'fake:live/2',
            'fake:live/3',
        ]);
        expect(master.media.map((media) => media.uri)).toEqual([
            'fake:live/4',
            'fake:live/5',
        ]);
        // Nothing but the master went through the static path.
        expect(ctx.serve.served.map((item) => item.url)).toEqual([
            result.source.url,
        ]);
    });

    it('describes each playlist by its address, its base and its cadence — and no key without one', async () => {
        const ctx = liveContext(liveRoutes);
        const info = await loadMaster(MASTER_URL, ctx);
        await mungeSource(info, { angleId: null }, ctx);

        // Strict: with no session key a spec carries no key URI at all, so a
        // refresh leaves the playlist's own key lines as they are.
        expect(ctx.serve.liveSpecs[1]).toStrictEqual({
            url: VARIANTS[1],
            baseUrl: VARIANTS[1],
            refreshSec: 4,
        });
    });

    it("names the key sentinel and carries the key bytes for a 'memory' adapter", async () => {
        const ctx = liveContext(
            { ...liveRoutes, [VARIANTS[0]!]: LIVE_ENCRYPTED },
            { keyHex: TEST_KEY_HEX },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        for (const spec of ctx.serve.liveSpecs) {
            expect(spec.keyUri).toBe(LUMINARY_KEY_PLACEHOLDER_URI);
            expect(spec.keyBytes).toEqual(keyBytes(TEST_KEY_HEX));
        }
        expect(ctx.serve.contentTypes()).not.toContain(KEY_CONTENT_TYPE);
        expect(result.source.keyHex).toBe(TEST_KEY_HEX);
    });

    it("points a 'url' adapter's live playlists at the one key it served", async () => {
        const ctx = liveContext(
            { ...liveRoutes, [VARIANTS[0]!]: LIVE_ENCRYPTED },
            { keyHex: TEST_KEY_HEX, keyDelivery: 'url' },
        );
        const info = await loadMaster(MASTER_URL, ctx);
        await mungeSource(info, { angleId: null }, ctx);

        const keys = ctx.serve.served.filter(
            (item) => item.contentType === KEY_CONTENT_TYPE,
        );
        expect(keys).toHaveLength(1);
        for (const spec of ctx.serve.liveSpecs) {
            expect(spec.keyUri).toBe(keys[0]!.url);
        }
    });

    it('decides per playlist, serving the finished ones of a mixed source as VOD', async () => {
        const ctx = liveContext({
            ...liveRoutes,
            ...Object.fromEntries(
                AUDIO.map((url) => [url, PLAIN_MEDIA_PLAYLIST]),
            ),
        });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        expect(result.isLive).toBe(true);
        expect(ctx.serve.liveSpecs.map((spec) => spec.url)).toEqual(VARIANTS);
        const media = parseMasterText(result.masterText).media;
        expect(ctx.serve.textOf(media[0]!.uri!)).toContain(
            `${BASE}/audio_hi_128kbps/segment_0.m4s`,
        );
    });

    it('serves a bare live media playlist as the source itself', async () => {
        const ctx = liveContext({ [MASTER_URL]: LIVE_MEDIA_PLAYLIST });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        expect(result.isLive).toBe(true);
        expect(result.source.url).toBe('fake:live/1');
        expect(ctx.serve.liveSpecs).toStrictEqual([
            { url: MASTER_URL, baseUrl: MASTER_URL, refreshSec: 4 },
        ]);
        expect(ctx.serve.served).toEqual([]);
    });

    it('does not call a finished source live, whatever the serving layer can do', async () => {
        const ctx = liveContext({
            [MASTER_URL]: SIMPLE_MASTER,
            ...everyPlaylist(PLAIN_MEDIA_PLAYLIST),
        });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(info, { angleId: null }, ctx);

        expect(result.isLive).toBe(false);
        expect(ctx.serve.liveSpecs).toEqual([]);
    });
});

describe('mungeSource — reading the media playlists', () => {
    /** SIMPLE_MASTER's playlists in master order: variants, then renditions. */
    const MEDIA = [
        'stream_1080',
        'stream_720',
        'stream_480',
        'audio_hi_128kbps',
        'audio_lo_64kbps',
    ].map((dir) => `${BASE}/${dir}/playlist.m3u8`);
    const info = describeMaster(MASTER_URL, SIMPLE_MASTER);

    function deferredContext() {
        const reads = makeDeferredFetch();
        const serve = new FakeServeStrategy();
        const ctx: PipelineContext = {
            fetchImpl: reads.fetchImpl,
            serveStrategy: serve,
            keyDelivery: 'memory',
            cache: new Map(),
        };
        return { ctx, reads, serve };
    }

    it('requests every media playlist before any has answered', async () => {
        // One after another, the reads put a round trip per playlist in front
        // of playback — twenty on a multi-language live ladder.
        const { ctx, reads } = deferredContext();
        const munged = mungeSource(info, { angleId: null }, ctx);
        await flush();

        expect(reads.calls).toEqual(MEDIA);

        for (const url of MEDIA) reads.respond(url, PLAIN_MEDIA_PLAYLIST);
        await expect(munged).resolves.toMatchObject({ isLive: false });
    });

    it('keeps master order however the answers arrive', async () => {
        const { ctx, reads, serve } = deferredContext();
        const munged = mungeSource(info, { angleId: null }, ctx);
        await flush();
        for (const url of [...MEDIA].reverse()) {
            reads.respond(url, PLAIN_MEDIA_PLAYLIST);
            await flush();
        }
        const result = await munged;

        expect(result.mediaPlaylists.map((playlist) => playlist.url)).toEqual(
            MEDIA,
        );
        // The strategy is asked to serve them in that order too, master last.
        const servedFrom = serve.served
            .slice(0, -1)
            .map(
                (item) =>
                    /^https:\/\/\S+\/segment_0\.m4s$/m.exec(
                        String(item.content),
                    )?.[0],
            );
        expect(servedFrom).toEqual(
            MEDIA.map((url) => url.replace('playlist.m3u8', 'segment_0.m4s')),
        );
        expect(serve.served.at(-1)?.url).toBe(result.source.url);
    });

    it('reports the first failure in master order, not the first to arrive', async () => {
        // Which failure surfaces decides what the viewer is told — a missing
        // playlist is "coming soon", a server error is an error — so it cannot
        // be left to timing.
        const { ctx, reads } = deferredContext();
        const munged = mungeSource(info, { angleId: null }, ctx);
        await flush();

        reads.respond(MEDIA[2]!, { status: 500 });
        await flush();
        reads.respond(MEDIA[0]!, { status: 404 });

        await expect(munged).rejects.toMatchObject({
            code: 'fetch-failed',
            missing: true,
            url: MEDIA[0],
        });
    });

    it('leaves no unhandled rejection behind when an earlier read has failed', async () => {
        // The munge stops at the first failure, so the reads after it are never
        // awaited — one of them failing too must not surface as unhandled.
        const unhandled: unknown[] = [];
        const record = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', record);
        try {
            const { ctx, reads } = deferredContext();
            const munged = mungeSource(info, { angleId: null }, ctx);
            await flush();

            reads.respond(MEDIA[0]!, { status: 404 });
            await expect(munged).rejects.toMatchObject({ code: 'fetch-failed' });
            for (const url of MEDIA.slice(1)) {
                reads.respond(url, { status: 500 });
            }
            await flush();

            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', record);
        }
    });

    it('reads a playlist once, however many spellings the master has for it', async () => {
        const ctx = context({
            [MASTER_URL]: SIMPLE_MASTER.replace(
                '\nstream_480/playlist.m3u8',
                '\n./stream_720/playlist.m3u8',
            ),
            [`${BASE}/stream_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
            [`${BASE}/stream_720/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
            [`${BASE}/audio_hi_128kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
            [`${BASE}/audio_lo_64kbps/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        });
        const respelled = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(respelled, { angleId: null }, ctx);

        expect(
            ctx.calls.filter((url) => url === `${BASE}/stream_720/playlist.m3u8`),
        ).toHaveLength(1);
        // Both spellings are swapped for the served copy.
        for (const variant of parseMasterText(result.masterText).variants) {
            expect(variant.uri).toMatch(/^fake:served\//);
        }
    });
});
