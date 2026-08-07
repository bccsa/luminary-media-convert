/**
 * Shared spec fixtures and fakes. Excluded from the tsc build (see
 * tsconfig.json) — it exists only for `*.spec.ts`.
 */

import { createCipheriv } from 'node:crypto';
import { LMCENC_MAGIC } from '@luminary-media-converter/hls';
import type {
    AdapterAudioTrack,
    AdapterEventMap,
    AdapterEventName,
    AdapterTextTrack,
    AdapterVariant,
    AdapterSource,
    PlayerAdapter,
    ServeStrategy,
    Unsubscribe,
} from '../types.js';

// ---------------------------------------------------------------------------
// Playlist fixtures
// ---------------------------------------------------------------------------

/** Single-angle ABR master: 1080/720/480 across two audio groups. */
export const SIMPLE_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_hi",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio_hi_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud_lo",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio_lo_64kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud_hi"',
    'stream_1080/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud_hi"',
    'stream_720/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud_lo"',
    'stream_480/playlist.m3u8',
    '',
].join('\n');

/** Two camera angles as `TYPE=VIDEO` rendition groups, plus audio + subtitles. */
export const MULTI_ANGLE_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="angle_0",NAME="Wide",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="angle_1",NAME="Close",DEFAULT=NO',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="subs_en/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",VIDEO="angle_0",AUDIO="aud",SUBTITLES="subs"',
    'angle0_1080/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",VIDEO="angle_0",AUDIO="aud",SUBTITLES="subs"',
    'angle0_720/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",VIDEO="angle_1",AUDIO="aud",SUBTITLES="subs"',
    'angle1_1080/playlist.m3u8',
    '',
].join('\n');

/** Audio-only encode: no video variants at all. */
export const AUDIO_ONLY_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio_128kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="aud"',
    'audio_128kbps/playlist.m3u8',
    '',
].join('\n');

/** fMP4 + byte-range + AES-128, exactly the shape the encoder emits. */
export const ENCRYPTED_MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x00000000000000000000000000000001',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:120000@0',
    'data_0.m4s',
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:118000@120000',
    'data_0.m4s',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

/** Plain, unencrypted media playlist. */
export const PLAIN_MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.000000,',
    'segment_0.m4s',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

/** Subtitles media playlist referencing WebVTT segments. */
export const SUBTITLE_MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:60',
    '#EXTINF:60.000000,',
    'en_0.vtt',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

export const CHAPTERS_VTT = [
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:01:30.500',
    'Opening',
    '',
    '2',
    '00:01:30.500 --> 00:04:00.000',
    'The interview',
    '',
].join('\n');

// ---------------------------------------------------------------------------
// LMCENC fixture builder
// ---------------------------------------------------------------------------

/** 000102…0f — the shared spec key. */
export const TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f';

/** Build an LMCENC payload with node crypto (mirrors the API encryptor). */
export function encryptLmcenc(
    plaintext: string,
    keyHex = TEST_KEY_HEX,
    iv: Uint8Array = new Uint8Array(16).fill(7),
): Uint8Array {
    const key = Buffer.from(keyHex, 'hex');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(iv));
    const body = Buffer.concat([
        cipher.update(Buffer.from(plaintext, 'utf-8')),
        cipher.final(),
    ]);
    return new Uint8Array(
        Buffer.concat([
            Buffer.from(LMCENC_MAGIC, 'ascii'),
            Buffer.from(iv),
            body,
        ]),
    );
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export interface ServedItem {
    url: string;
    content: string | Uint8Array;
    contentType: string;
}

/** {@link ServeStrategy} that records everything instead of minting blobs. */
export class FakeServeStrategy implements ServeStrategy {
    /** Everything ever served, across generations. */
    readonly served: ServedItem[] = [];
    /** Served since the last `release()`. */
    live: ServedItem[] = [];
    releaseCount = 0;
    private counter = 0;

    serve(content: string | Uint8Array, contentType: string): string {
        const url = `fake:served/${++this.counter}`;
        const item = { url, content, contentType };
        this.served.push(item);
        this.live.push(item);
        return url;
    }

    release(): void {
        this.releaseCount += 1;
        this.live = [];
    }

    contentOf(url: string): string | Uint8Array | undefined {
        return this.served.find((item) => item.url === url)?.content;
    }

    textOf(url: string): string {
        const content = this.contentOf(url);
        if (typeof content !== 'string') {
            throw new Error(`No text served at ${url}`);
        }
        return content;
    }

    /** Content types served, in order — used to prove no key was ever minted. */
    contentTypes(): string[] {
        return this.served.map((item) => item.contentType);
    }
}

export type RouteBody =
    | string
    | Uint8Array
    | { status: number; body?: string | Uint8Array };

export interface FakeFetch {
    fetchImpl: typeof fetch;
    calls: string[];
    routes: Map<string, RouteBody>;
}

/** Minimal `fetch` over a URL → body map. Unknown URLs answer 404. */
export function makeFetch(routes: Record<string, RouteBody>): FakeFetch {
    const table = new Map(Object.entries(routes));
    const calls: string[] = [];

    const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        const route = table.get(url);
        if (route === undefined) return makeResponse(404);
        if (typeof route === 'string' || route instanceof Uint8Array) {
            return makeResponse(200, route);
        }
        return makeResponse(route.status, route.body);
    }) as unknown as typeof fetch;

    return { fetchImpl, calls, routes: table };
}

function makeResponse(status: number, body?: string | Uint8Array): Response {
    const bytes =
        body === undefined
            ? new Uint8Array(0)
            : typeof body === 'string'
              ? new TextEncoder().encode(body)
              : body;
    return {
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () => {
            const copy = new Uint8Array(bytes.length);
            copy.set(bytes);
            return copy.buffer;
        },
    } as unknown as Response;
}

export interface FakeAdapterOptions {
    keyDelivery?: 'memory' | 'url';
    nativeHls?: boolean;
    variants?: AdapterVariant[];
    audioTracks?: AdapterAudioTrack[];
    recoverResult?: boolean;
}

/** Scriptable {@link PlayerAdapter} for controller specs. */
export class FakeAdapter implements PlayerAdapter {
    readonly capabilities: PlayerAdapter['capabilities'];

    readonly loads: AdapterSource[] = [];
    readonly seeks: number[] = [];
    readonly variantCalls: string[] = [];
    readonly audioTrackCalls: string[] = [];
    readonly recoverCalls: string[] = [];
    textTracks: AdapterTextTrack[] = [];
    activeTextTrackId: string | null = null;
    playCount = 0;
    pauseCount = 0;
    destroyed = false;
    currentTime = 0;
    duration = 0;
    playbackRate = 1;
    recoverResult: boolean;

    private variants: AdapterVariant[];
    private audioTracks: AdapterAudioTrack[];
    private readonly listeners = new Map<
        string,
        Set<(payload: never) => void>
    >();

    constructor(options: FakeAdapterOptions = {}) {
        this.capabilities = {
            nativeHls: options.nativeHls ?? false,
            keyDelivery: options.keyDelivery ?? 'memory',
            variantSwitching: true,
            renderText: true,
        };
        this.variants = options.variants ?? [];
        this.audioTracks = options.audioTracks ?? [];
        this.recoverResult = options.recoverResult ?? true;
    }

    async loadSource(src: AdapterSource): Promise<void> {
        this.loads.push(src);
    }

    destroy(): void {
        this.destroyed = true;
    }

    async play(): Promise<void> {
        this.playCount += 1;
    }

    pause(): void {
        this.pauseCount += 1;
    }

    seek(seconds: number): void {
        this.seeks.push(seconds);
        this.currentTime = seconds;
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getDuration(): number {
        return this.duration;
    }

    setPlaybackRate(rate: number): void {
        this.playbackRate = rate;
    }

    getVariants(): AdapterVariant[] {
        return this.variants;
    }

    setVariants(variants: AdapterVariant[]): void {
        this.variants = variants;
        this.emit('variants-updated', undefined);
    }

    setVariant(id: string): void {
        this.variantCalls.push(id);
    }

    getAudioTracks(): AdapterAudioTrack[] {
        return this.audioTracks;
    }

    publishAudioTracks(tracks: AdapterAudioTrack[]): void {
        this.audioTracks = tracks;
        this.emit('audiotracks-updated', undefined);
    }

    setAudioTrack(id: string): void {
        this.audioTrackCalls.push(id);
    }

    setTextTracks(tracks: AdapterTextTrack[]): void {
        this.textTracks = tracks;
    }

    setActiveTextTrack(id: string | null): void {
        this.activeTextTrackId = id;
    }

    recover(category: 'network' | 'media' | 'other'): boolean {
        this.recoverCalls.push(category);
        return this.recoverResult;
    }

    on<E extends AdapterEventName>(
        event: E,
        listener: (payload: AdapterEventMap[E]) => void,
    ): Unsubscribe {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        const entry = listener as (payload: never) => void;
        set.add(entry);
        return () => {
            set?.delete(entry);
        };
    }

    emit<E extends AdapterEventName>(
        event: E,
        payload: AdapterEventMap[E],
    ): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            (listener as (payload: AdapterEventMap[E]) => void)(payload);
        }
    }

    /** Convenience: advance playback time and emit `timeupdate`. */
    advanceTo(seconds: number): void {
        this.currentTime = seconds;
        this.emit('timeupdate', { currentTime: seconds });
    }
}

/**
 * Let pending async work settle. Uses the REAL timer captured at module load,
 * so it works under `vi.useFakeTimers()` and covers WebCrypto operations, which
 * resolve off the microtask queue.
 */
const realSetTimeout = globalThis.setTimeout;

export async function flush(times = 3): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    }
}
