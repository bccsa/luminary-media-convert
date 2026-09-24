import { describe, expect, it } from 'vitest';
import {
    describeLiveness,
    resolveLivePlaylist,
    type LivePlaylistSpec,
} from './live.js';
import { keyBytes } from '../pipeline/decrypt.js';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '../pipeline/rewrite-media.js';
import {
    ENCRYPTED_MEDIA_PLAYLIST,
    LIVE_MEDIA_PLAYLIST,
    PLAIN_MEDIA_PLAYLIST,
    TEST_KEY_HEX,
    encryptLmcenc,
    makeFetch,
} from '../test-support/index.js';

const DIR = 'https://live.example.com/channel/video_360';
const LIVE_URL = `${DIR}/chunks.m3u8`;

/** The encoder's AES-128 fixture, still being written. */
const LIVE_ENCRYPTED = ENCRYPTED_MEDIA_PLAYLIST.replace('#EXT-X-ENDLIST\n', '');

/** A two-segment window starting at `first`, as the packager rewrites it. */
function liveWindow(first: number): string {
    return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        `#EXT-X-MEDIA-SEQUENCE:${first}`,
        '#EXTINF:4,',
        `l_${first}.ts`,
        '#EXTINF:4,',
        `l_${first + 1}.ts`,
        '',
    ].join('\n');
}

function spec(overrides: Partial<LivePlaylistSpec> = {}): LivePlaylistSpec {
    return { url: LIVE_URL, baseUrl: LIVE_URL, refreshSec: 4, ...overrides };
}

describe('describeLiveness', () => {
    it('calls a playlist without #EXT-X-ENDLIST live, and reads its cadence', () => {
        expect(describeLiveness(LIVE_MEDIA_PLAYLIST)).toEqual({
            isLive: true,
            targetDurationSec: 4,
            mediaSequence: 87996,
        });
    });

    it('calls a finished playlist finished', () => {
        expect(describeLiveness(PLAIN_MEDIA_PLAYLIST).isLive).toBe(false);
    });

    it('goes by #EXT-X-ENDLIST, not by the type the playlist declares', () => {
        // A VOD playlist without its end tag is a writer mid-flight, and will
        // grow; treating it as finished would play what exists and stop.
        expect(LIVE_ENCRYPTED).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(describeLiveness(LIVE_ENCRYPTED).isLive).toBe(true);
    });
});

describe('resolveLivePlaylist', () => {
    it('reads the playlist afresh on every call', async () => {
        // Every engine refresh has to see the window move on; a cached read
        // would freeze the stream at its first snapshot.
        const { fetchImpl, calls, routes } = makeFetch({
            [LIVE_URL]: liveWindow(100),
        });

        const first = await resolveLivePlaylist(spec(), { fetchImpl });
        routes.set(LIVE_URL, liveWindow(101));
        const second = await resolveLivePlaylist(spec(), { fetchImpl });

        expect(calls).toEqual([LIVE_URL, LIVE_URL]);
        expect(first).toContain(`${DIR}/l_100.ts`);
        expect(second).toContain(`${DIR}/l_102.ts`);
        expect(second).not.toContain('l_100.ts');
    });

    it('absolutizes every URI against the base, not against where it was read', () => {
        // The engine only ever sees the served address, so a relative URI left
        // in the text would resolve against that instead.
        const { fetchImpl } = makeFetch({ [LIVE_URL]: liveWindow(100) });
        const edge = 'https://edge.example.com/cache/video_360/chunks.m3u8';

        return expect(
            resolveLivePlaylist(spec({ baseUrl: edge }), { fetchImpl }),
        ).resolves.toContain('https://edge.example.com/cache/video_360/l_100.ts');
    });

    it('leaves the tags it does not rewrite exactly as written', async () => {
        const { fetchImpl } = makeFetch({ [LIVE_URL]: liveWindow(100) });
        const text = await resolveLivePlaylist(spec(), { fetchImpl });

        expect(text.split('\n').slice(0, 5)).toEqual([
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-MEDIA-SEQUENCE:100',
            '#EXTINF:4,',
        ]);
    });

    it('points AES-128 keys at the key URI, leaving IV and the rest alone', async () => {
        const { fetchImpl } = makeFetch({ [LIVE_URL]: LIVE_ENCRYPTED });
        const text = await resolveLivePlaylist(
            spec({
                keyUri: 'fake:served/key',
                keyBytes: keyBytes(TEST_KEY_HEX),
            }),
            { fetchImpl },
        );

        expect(text).toContain(
            '#EXT-X-KEY:METHOD=AES-128,URI="fake:served/key",IV=0x00000000000000000000000000000001',
        );
        expect(text).toContain(`#EXT-X-MAP:URI="${DIR}/init.mp4"`);
    });

    it('decrypts an LMCENC-wrapped playlist with the session key', async () => {
        const { fetchImpl } = makeFetch({
            [LIVE_URL]: encryptLmcenc(liveWindow(100)),
        });
        const text = await resolveLivePlaylist(
            spec({
                keyUri: LUMINARY_KEY_PLACEHOLDER_URI,
                keyBytes: keyBytes(TEST_KEY_HEX),
            }),
            { fetchImpl },
        );

        expect(text).toContain(`${DIR}/l_100.ts`);
    });

    it('passes a plaintext playlist through when a key is configured', async () => {
        // Sniffed, not assumed: the same code path serves a Luminary stream and
        // a third-party one without knowing in advance which it has.
        const { fetchImpl } = makeFetch({ [LIVE_URL]: liveWindow(100) });
        const text = await resolveLivePlaylist(
            spec({
                keyUri: LUMINARY_KEY_PLACEHOLDER_URI,
                keyBytes: keyBytes(TEST_KEY_HEX),
            }),
            { fetchImpl },
        );

        expect(text).toContain(`${DIR}/l_100.ts`);
    });

    it('fails with key-required when an AES-128 key turns up and there is no key', async () => {
        // The rule the load applies to the first read, applied to every read: a
        // live stream can start encrypting part-way through.
        const { fetchImpl } = makeFetch({ [LIVE_URL]: LIVE_ENCRYPTED });

        await expect(
            resolveLivePlaylist(spec(), { fetchImpl }),
        ).rejects.toMatchObject({ code: 'key-required', url: LIVE_URL });
    });

    it('does not count METHOD=NONE as a key', async () => {
        const playlist = liveWindow(100).replace(
            '#EXTINF',
            '#EXT-X-KEY:METHOD=NONE\n#EXTINF',
        );
        const { fetchImpl } = makeFetch({ [LIVE_URL]: playlist });
        const text = await resolveLivePlaylist(spec(), { fetchImpl });

        expect(text).toContain('#EXT-X-KEY:METHOD=NONE\n');
    });

    it('fails with key-required on an LMCENC playlist when there is no key', async () => {
        const { fetchImpl } = makeFetch({
            [LIVE_URL]: encryptLmcenc(liveWindow(100)),
        });

        await expect(
            resolveLivePlaylist(spec(), { fetchImpl }),
        ).rejects.toMatchObject({ code: 'key-required' });
    });

    it('fails with the status the upstream answered with', async () => {
        for (const [status, missing] of [
            [404, true],
            [503, false],
        ] as const) {
            const { fetchImpl } = makeFetch({ [LIVE_URL]: { status } });

            await expect(
                resolveLivePlaylist(spec(), { fetchImpl }),
            ).rejects.toMatchObject({ code: 'fetch-failed', status, missing });
        }
    });

    it("hands the caller's abort signal to the read", async () => {
        // An engine that stops waiting for a refresh must be able to stop the
        // request behind it.
        const signals: (AbortSignal | null | undefined)[] = [];
        const { fetchImpl: inner } = makeFetch({ [LIVE_URL]: liveWindow(100) });
        const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
            signals.push(init?.signal);
            return inner(input, init);
        }) as typeof fetch;
        const controller = new AbortController();

        await resolveLivePlaylist(spec(), {
            fetchImpl,
            signal: controller.signal,
        });

        expect(signals).toEqual([controller.signal]);
    });
});
