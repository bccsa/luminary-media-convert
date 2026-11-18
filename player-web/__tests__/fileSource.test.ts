import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hls } from '@videojs/hlsjs-video';
import { HlsJsVideoAdapter } from '../src/adapter/HlsJsVideoAdapter';
import { adapterSource, fakeElement } from './helpers';

/** A native `AudioTrackList` / `VideoTrackList`: indexable, with a length, an event target. */
type NativeTrack = {
    id: string;
    label: string;
    language: string;
    enabled?: boolean;
    selected?: boolean;
};
function nativeList(
    tracks: NativeTrack[]
): EventTarget & { length: number } & Record<number, NativeTrack> {
    const list = new EventTarget() as EventTarget & { length: number } & Record<
            number,
            NativeTrack
        >;
    list.length = tracks.length;
    tracks.forEach((track, i) => (list[i] = track));
    return list;
}

let el: ReturnType<typeof fakeElement> & {
    target?: unknown;
    load?: () => void;
    error?: { code: number } | null;
};
let video: {
    audioTracks: ReturnType<typeof nativeList>;
    videoTracks: ReturnType<typeof nativeList>;
    videoWidth: number;
};
let adapter: HlsJsVideoAdapter;

const FILE = 'http://127.0.0.1:31711/api/sessions/s1/source?token=t';

function events(
    a: HlsJsVideoAdapter,
    ...names: Parameters<HlsJsVideoAdapter['on']>[0][]
) {
    const seen: [string, unknown][] = [];
    for (const name of names)
        a.on(name, ((payload: unknown) => seen.push([name, payload])) as never);
    return seen;
}

const loadFile = (overrides = {}) =>
    adapter.loadSource(
        adapterSource({ url: FILE, isBlob: false, kind: 'file', ...overrides })
    );

const metadataRead = () => el.dispatchEvent(new Event('loadedmetadata'));

beforeEach(() => {
    vi.spyOn(Hls, 'isSupported').mockReturnValue(true);
    el = fakeElement();
    el.load = vi.fn();
    video = {
        audioTracks: nativeList([
            { id: '1', label: 'English', language: 'en', enabled: true },
            { id: '2', label: '', language: 'fr', enabled: false },
        ]),
        videoTracks: nativeList([
            { id: '1', label: '', language: '', selected: true },
            { id: '2', label: '', language: '', selected: false },
        ]),
        videoWidth: 1920,
    };
    el.target = video;
    adapter = new HlsJsVideoAdapter(el);
});

afterEach(() => {
    adapter.destroy();
    vi.restoreAllMocks();
});

describe('a file source', () => {
    it('goes to the browser as a typed file, with no hls.js engine', async () => {
        await loadFile();
        // Untyped, the element would infer HLS from a URL not ending in .mp4.
        expect(el.source).toEqual({ src: FILE, type: 'video/mp4' });
    });

    it("lists no tracks until the metadata is read, then the file's own", async () => {
        await loadFile();
        expect(adapter.getAudioTracks()).toEqual([]);
        expect(adapter.getVideoTracks()).toEqual([]);

        metadataRead();

        expect(adapter.getAudioTracks()).toEqual([
            { id: '1', lang: 'en', label: 'English' },
            { id: '2', lang: 'fr', label: 'Track 2' },
        ]);
        expect(
            adapter.getVideoTracks().map((t) => [t.label, t.selected])
        ).toEqual([
            ['Angle 1', true],
            ['Angle 2', false],
        ]);
    });

    it('announces the tracks once the metadata is in', async () => {
        await loadFile();
        const seen = events(
            adapter,
            'audiotracks-updated',
            'videotracks-updated'
        );
        metadataRead();
        expect(seen.map(([name]) => name)).toEqual([
            'audiotracks-updated',
            'videotracks-updated',
        ]);
    });

    it('leaves only the chosen audio track enabled: a native list plays every enabled one', async () => {
        await loadFile();
        metadataRead();
        adapter.setAudioTrack('2');
        expect([
            video.audioTracks[0].enabled,
            video.audioTracks[1].enabled,
        ]).toEqual([false, true]);
    });

    /** Records how many tracks are enabled after every change the adapter makes. */
    const watchEnabled = () => {
        const counts: number[] = [];
        const tracks = [video.audioTracks[0], video.audioTracks[1]];
        const state = tracks.map((t) => t.enabled === true);
        tracks.forEach((track, i) =>
            Object.defineProperty(track, 'enabled', {
                get: () => state[i],
                set: (on: boolean) => {
                    state[i] = on;
                    counts.push(state.filter(Boolean).length);
                },
            })
        );
        return counts;
    };

    it('never leaves the file without an enabled audio track while switching', async () => {
        // With none enabled for a moment, Chromium restarts playback with no sound and stalls.
        await loadFile();
        metadataRead();
        const counts = watchEnabled();
        adapter.setAudioTrack('2');
        expect(counts).not.toContain(0);
        adapter.setAudioTrack('1');
        expect(counts).not.toContain(0);
        expect(video.audioTracks[0].enabled).toBe(true);
        expect(video.audioTracks[1].enabled).toBe(false);
    });

    it('seeks to where it stands after switching, so picture and sound restart together', async () => {
        await loadFile();
        metadataRead();
        let position = 12.5;
        const seeks: number[] = [];
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => position,
            set: (t: number) => {
                seeks.push(t);
                position = t;
            },
        });
        adapter.setAudioTrack('2');
        expect(seeks).toEqual([12.5]);
        adapter.setAudioTrack('2');
        expect(seeks).toEqual([12.5]);
    });

    it('leaves the tracks alone when the chosen one is already playing', async () => {
        // Every change to the list restarts playback.
        await loadFile();
        metadataRead();
        const counts = watchEnabled();
        adapter.setAudioTrack('1');
        expect(counts).toEqual([]);
    });

    it('ignores an audio track the file does not have', async () => {
        await loadFile();
        metadataRead();
        adapter.setAudioTrack('9');
        expect([
            video.audioTracks[0].enabled,
            video.audioTracks[1].enabled,
        ]).toEqual([true, false]);
    });

    it('switches angle by selecting the video track', async () => {
        await loadFile();
        metadataRead();
        adapter.setVideoTrack('2');
        expect(video.videoTracks[1].selected).toBe(true);
    });

    describe('a file the browser never finishes reading', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('fails as media, so the host can play something else', async () => {
            // A stuck load reports no error of its own.
            vi.useFakeTimers();
            await loadFile();
            const seen = events(adapter, 'error');
            await vi.advanceTimersByTimeAsync(20_000);
            expect(seen).toHaveLength(1);
            expect(seen[0][1]).toMatchObject({
                category: 'media',
                fatal: true,
            });
        });

        it('waits no longer once the metadata is in', async () => {
            vi.useFakeTimers();
            await loadFile();
            const seen = events(adapter, 'error');
            metadataRead();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(seen).toHaveLength(0);
        });
    });

    it('fails as media when the browser finds no picture in a file that has one', async () => {
        // The browser drops a video stream it cannot decode and plays the sound alone.
        await loadFile({ expectVideo: true });
        video.videoWidth = 0;
        const seen = events(adapter, 'error');
        metadataRead();
        expect(seen).toHaveLength(1);
        expect(seen[0][1]).toMatchObject({ category: 'media', fatal: true });
    });

    it('does not fail an audio-only file for having no picture', async () => {
        await loadFile({ expectVideo: false });
        video.videoWidth = 0;
        const seen = events(adapter, 'error');
        metadataRead();
        expect(seen).toHaveLength(0);
    });

    it.each([
        [2, 'network'],
        [3, 'media'],
        [4, 'media'],
    ])(
        'reports a media error code %i as a fatal %s error',
        async (code, category) => {
            await loadFile();
            el.error = { code };
            const seen = events(adapter, 'error');
            el.dispatchEvent(new Event('error'));
            expect(seen[0][1]).toMatchObject({ category, fatal: true });
        }
    );

    it('reloads when handed the file it already has', async () => {
        await loadFile();
        el.src = FILE;
        await loadFile();
        expect(el.load).toHaveBeenCalledTimes(1);
    });

    it('holds a seek until the metadata is read', async () => {
        el.readyState = 4;
        await loadFile();
        adapter.seek(10);
        expect(el.currentTime).toBe(0);
        metadataRead();
        expect(el.currentTime).toBe(10);
    });

    it('stops listening to the native lists once an HLS source replaces it', async () => {
        await loadFile();
        metadataRead();
        await adapter.loadSource(adapterSource());
        const seen = events(
            adapter,
            'audiotracks-updated',
            'videotracks-updated',
            'error'
        );

        video.audioTracks.dispatchEvent(new Event('change'));
        video.videoTracks.dispatchEvent(new Event('change'));
        el.error = { code: 3 };
        el.dispatchEvent(new Event('error'));

        // An HLS source's errors come from hls.js and its recovery ladder.
        expect(seen).toEqual([]);
        expect(adapter.getVideoTracks()).toEqual([]);
    });
});
