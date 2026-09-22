import { afterEach, describe, it, expect, vi } from 'vitest';
import { DEFAULT_RECOVERY_POLICY } from '@luminary-media-converter/player-core';
import { VideoJsAdapter } from '../src/adapter/VideoJsAdapter';
import { fakePlayer } from './helpers';

describe('VideoJsAdapter — the contract player-core relies on', () => {
    it('serves keys from memory by default, and says so', () => {
        // The capability is load-bearing: the wrapper mints a key blob URL only
        // for adapters that decline the job, so claiming 'memory' without doing
        // it would leave AES requests unanswered.
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.capabilities.keyDelivery).toBe('memory');
        expect(a.capabilities.nativeHls).toBe(false);
        expect(a.capabilities.variantSwitching).toBe(true);
        expect(a.capabilities.renderText).toBe(true);
    });

    it('honours the documented fallback when the VHS seam is declined', () => {
        const a = new VideoJsAdapter(fakePlayer(), { keyDelivery: 'url' });
        expect(a.capabilities.keyDelivery).toBe('url');
    });

    it('reports the ladder as variants, identified by height', () => {
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.getVariants()).toEqual([
            { id: '360', height: 360, bandwidth: 800_000 },
            { id: '720', height: 720, bandwidth: 2_400_000 },
        ]);
    });

    it('pins one quality and lets `auto` restore the ladder', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setVariant('720');
        expect(p._levels.map((l: any) => l.enabled)).toEqual([false, true]);

        a.setVariant('auto');
        expect(p._levels.map((l: any) => l.enabled)).toEqual([true, true]);
    });

    it('treats an id that matches no level as auto, not as a pin nothing satisfies', () => {
        // An angle switch rebuilds the ladder under a pinned quality. Disabling
        // every level would leave VHS on whatever it holds with ABR unable to
        // move — a stall dressed as a choice.
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setVariant('1080');

        expect(p._levels.map((l: any) => l.enabled)).toEqual([true, true]);
    });

    it('lists audio tracks, falling back to an index when one has no id', () => {
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.getAudioTracks()).toEqual([
            { id: 'en', lang: 'en', label: 'English' },
            { id: 'fr', lang: 'fr', label: 'French' },
        ]);
    });

    it('enables only the chosen audio track, and never disables first', () => {
        // Writing false across the list before enabling the match leaves a frame
        // with no audio track at all, which VHS resolves by picking for itself.
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);

        a.setAudioTrack('fr');

        const list = p.audioTracks();
        expect(list[1].enabled).toBe(true);
    });

    it('reports position and duration through the engine', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        p.currentTime(30);
        expect(a.getCurrentTime()).toBe(30);
        expect(a.getDuration()).toBe(120);
    });

    it('translates engine events into adapter events', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        a.on('playing', () => seen.push('playing'));
        a.on('pause', () => seen.push('pause'));
        a.on('waiting', () => seen.push('waiting'));
        a.on('ended', () => seen.push('ended'));

        p.fire('playing');
        p.fire('pause');
        p.fire('waiting');
        p.fire('ended');

        expect(seen).toEqual(['playing', 'pause', 'waiting', 'ended']);
    });

    it('reports the buffered front, which moves while paused', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: number[] = [];
        a.on('progress', (e) => seen.push(e.bufferedEnd));

        p.fire('progress');

        expect(seen).toEqual([42]);
    });

    it('unsubscribing stops delivery to that listener alone', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        const off = a.on('playing', () => seen.push('first'));
        a.on('playing', () => seen.push('second'));

        off();
        p.fire('playing');

        expect(seen).toEqual(['second']);
    });

    it('declines a recovery it cannot attempt, so the wrapper reloads instead', () => {
        // Returning true for a recovery that did nothing is worse than saying no:
        // the wrapper believes it and stops escalating.
        const a = new VideoJsAdapter(fakePlayer());
        expect(a.recover('network')).toBe(false);
        expect(a.recover('media')).toBe(false);
        expect(a.recover('other')).toBe(false);
    });

    it('stops listening once destroyed', () => {
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        const seen: string[] = [];
        a.on('playing', () => seen.push('playing'));

        a.destroy();
        p.fire('playing');

        expect(seen).toEqual([]);
    });

    it('survives a second destroy', () => {
        const a = new VideoJsAdapter(fakePlayer());
        a.destroy();
        expect(() => a.destroy()).not.toThrow();
    });

    it('does not fall over on a player without quality levels or audio tracks', () => {
        // Not hypothetical: the YouTube tech has neither, and the adapter is
        // constructed before the source decides which tech runs.
        const bare = fakePlayer({ qualityLevels: undefined, audioTracks: undefined });
        const a = new VideoJsAdapter(bare);

        expect(a.getVariants()).toEqual([]);
        expect(a.getAudioTracks()).toEqual([]);
        expect(() => a.setVariant('720')).not.toThrow();
        expect(() => a.setAudioTrack('en')).not.toThrow();
    });
});

describe('VideoJsAdapter — recovery ladder', () => {
    const source = { url: 'blob:master', isBlob: true, recovery: DEFAULT_RECOVERY_POLICY };
    // Each adapter listens on the shared `document`; one left behind would
    // answer the next test's visibility changes.
    const adapters: VideoJsAdapter[] = [];

    function setup() {
        vi.useFakeTimers();
        vi.stubGlobal('MediaSource', class {});
        const p = fakePlayer();
        const a = new VideoJsAdapter(p);
        adapters.push(a);
        const errors: unknown[] = [];
        const reloads: number[] = [];
        a.on('error', (e) => errors.push(e));
        a.on('reload-requested', ({ attempt }) => reloads.push(attempt));
        return { p, a, errors, reloads };
    }

    function setVisibility(state: 'visible' | 'hidden') {
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    afterEach(() => {
        for (const a of adapters.splice(0)) a.destroy();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('does not count the position restored after a re-munge as recovery', async () => {
        const { p, a, errors } = setup();
        // What the controller does on `reload-requested`: rebuild, then restore the position.
        a.on('reload-requested', () => {
            void a.loadSource(source).then(() => {
                p._time = 0;
                a.seek(120);
                p.fire('timeupdate');
            });
        });
        await a.loadSource(source);
        p._time = 120;
        p.fire('timeupdate');

        // The same failure every time playback gets back to 120 s.
        p._error = { code: 2 };
        for (let i = 0; i < 10 && errors.length === 0; i++) {
            p.fire('error');
            await vi.advanceTimersByTimeAsync(10_000);
        }

        expect(errors).toHaveLength(1);
    });

    it('does not rebuild a source it has given up on when the page becomes visible', async () => {
        const { p, a, errors, reloads } = setup();
        await a.loadSource(source);
        p._error = { code: 3 };
        for (let i = 0; i < 6 && errors.length === 0; i++) {
            p.fire('error');
            await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(errors).toHaveLength(1);
        const requested = reloads.length;

        setVisibility('hidden');
        setVisibility('visible');

        expect(reloads).toHaveLength(requested);
    });

    it('re-raises a re-munge only when the page was hidden while it was outstanding', async () => {
        const { p, a, reloads } = setup();
        await a.loadSource(source);
        p._error = { code: 3 };
        // In place (declined), re-attach, then the first re-munge request.
        p.fire('error');
        await vi.advanceTimersByTimeAsync(10_000);
        p.fire('error');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reloads).toEqual([2]);

        // Delivered while visible: returning to the page must not repeat it.
        setVisibility('visible');
        expect(reloads).toEqual([2]);

        // Hidden while still outstanding: it may not have been delivered.
        setVisibility('hidden');
        setVisibility('visible');
        expect(reloads).toEqual([2, 2]);
    });
});
