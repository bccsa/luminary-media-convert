import { describe, expect, it } from 'vitest';
import { AUDIO_ONLY_ANGLE_ID } from '../types.js';
import {
    DEFAULT_ANGLE_ID,
    describeMaster,
    loadMaster,
    mungeSource,
    type PipelineContext,
} from './pipeline.js';
import { KEY_CONTENT_TYPE } from './blob-registry.js';
import { LUMINARY_KEY_PLACEHOLDER_URI } from './rewrite-media.js';
import { parseMasterText } from './playlist-text.js';
import {
    AUDIO_ONLY_MASTER,
    CHAPTERS_VTT,
    ENCRYPTED_MEDIA_PLAYLIST,
    FakeServeStrategy,
    MULTI_ANGLE_MASTER,
    PLAIN_MEDIA_PLAYLIST,
    SIMPLE_MASTER,
    SUBTITLE_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    encryptLmcenc,
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

describe('mungeSource — pass-through', () => {
    it('plays an unencrypted, un-narrowed master by its ORIGINAL url', async () => {
        const ctx = context({
            [MASTER_URL]: SIMPLE_MASTER,
            [`${BASE}/stream_1080/playlist.m3u8`]: PLAIN_MEDIA_PLAYLIST,
        });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );

        expect(result.source).toEqual({ url: MASTER_URL, isBlob: false });
        expect(ctx.serve.served).toEqual([]);
        expect(result.qualities.map((q) => q.id)).toEqual([
            '1080',
            '720',
            '480',
        ]);
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

    it('tolerates an unreachable probe target rather than failing the load', async () => {
        const ctx = context({ [MASTER_URL]: SIMPLE_MASTER });
        const info = await loadMaster(MASTER_URL, ctx);
        const result = await mungeSource(
            info,
            { angleId: DEFAULT_ANGLE_ID },
            ctx,
        );
        expect(result.source.isBlob).toBe(false);
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
