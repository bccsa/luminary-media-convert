// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { useChapters } from './useChapters';
import { exportChaptersVtt } from '@luminary-media-converter/segment-editor';

const STORAGE_PREFIX = 'luminary_chapters_';

function flushMicrotasks() {
    return new Promise<void>((r) => queueMicrotask(r));
}

describe('useChapters', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function setup(opts: Parameters<typeof useChapters>[0] = { getAccessToken: async () => 'token' }) {
        return useChapters({
            autosaveMs: 50,
            ...opts,
        });
    }

    describe('load', () => {
        it('starts with an empty list when neither local nor remote has data', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });

            await c.load('sess-1');

            expect(c.segments.value).toEqual([]);
            expect(c.isDirty.value).toBe(false);
            expect(c.isLoaded.value).toBe(true);
            expect(fetchRemote).toHaveBeenCalledWith('sess-1', 'en', 'tok');
        });

        it('parses the server VTT when present and stays clean', async () => {
            const fetchRemote = vi.fn().mockResolvedValue({
                vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nIntro\n',
            });
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });

            await c.load('sess-1');

            expect(c.segments.value).toHaveLength(1);
            expect(c.segments.value[0].label).toBe('Intro');
            expect(c.isDirty.value).toBe(false);
        });

        it('prefers localStorage over the server when both exist (dirty)', async () => {
            localStorage.setItem(
                STORAGE_PREFIX + 'sess-1',
                JSON.stringify({
                    lang: 'en',
                    segments: [{ id: 'a', inSec: 0, outSec: 10, label: 'Local' }],
                    updatedAt: '2026-04-25T00:00:00Z',
                }),
            );
            const fetchRemote = vi.fn().mockResolvedValue({
                vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nServer\n',
            });
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });

            await c.load('sess-1');

            expect(c.segments.value[0].label).toBe('Local');
            expect(c.isDirty.value).toBe(true);
            expect(fetchRemote).not.toHaveBeenCalled();
        });

        it('surfaces a load error when the server call throws', async () => {
            const fetchRemote = vi.fn().mockRejectedValue(new Error('boom'));
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });

            await c.load('sess-1');

            expect(c.segments.value).toEqual([]);
            expect(c.loadError.value).toBe('boom');
            expect(c.isLoaded.value).toBe(true);
        });

        it('ignores corrupt localStorage entries', async () => {
            localStorage.setItem(STORAGE_PREFIX + 'sess-1', 'not-json');
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });

            await c.load('sess-1');

            expect(fetchRemote).toHaveBeenCalled();
            expect(c.isDirty.value).toBe(false);
        });

        it('sets loadedSessionId to the session that was loaded', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-a');
            expect(c.loadedSessionId.value).toBe('sess-a');
        });

        it('does not apply results when unload races an in-flight remote load', async () => {
            let resolveRemote!: (v: { vtt: string } | null) => void;
            const remotePromise = new Promise<{ vtt: string } | null>((r) => {
                resolveRemote = r;
            });
            const fetchRemote = vi.fn().mockReturnValue(remotePromise);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            const p = c.load('sess-old');
            c.unload();
            resolveRemote({
                vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nStale\n',
            });
            await p;
            expect(c.segments.value).toEqual([]);
            expect(c.isLoaded.value).toBe(false);
            expect(c.loadedSessionId.value).toBeNull();
        });
    });

    describe('autosave', () => {
        it('writes segments to localStorage after the debounce window', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-1');
            await flushMicrotasks();

            c.segments.value = [{ id: 'a', inSec: 0, outSec: 10, label: 'A' }];
            await nextTick();

            // Before the debounce timer fires, nothing in storage yet but dirty=true.
            expect(c.isDirty.value).toBe(true);
            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeNull();

            vi.advanceTimersByTime(60);

            const stored = localStorage.getItem(STORAGE_PREFIX + 'sess-1');
            expect(stored).toBeTruthy();
            const parsed = JSON.parse(stored!);
            expect(parsed.lang).toBe('en');
            expect(parsed.segments[0].label).toBe('A');
        });

        it('coalesces multiple rapid edits into a single localStorage write', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-1');
            await flushMicrotasks();
            const setSpy = vi.spyOn(Storage.prototype, 'setItem');

            c.segments.value = [{ id: 'a', inSec: 0, outSec: 5 }];
            await nextTick();
            vi.advanceTimersByTime(20);
            c.segments.value = [{ id: 'a', inSec: 0, outSec: 10 }];
            await nextTick();
            vi.advanceTimersByTime(20);
            c.segments.value = [{ id: 'a', inSec: 0, outSec: 15 }];
            await nextTick();
            vi.advanceTimersByTime(60);

            expect(setSpy).toHaveBeenCalledTimes(1);
            setSpy.mockRestore();
        });

        it('does not autosave during the initial load', async () => {
            const fetchRemote = vi.fn().mockResolvedValue({
                vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nA\n',
            });
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-1');

            vi.advanceTimersByTime(200);

            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeNull();
            expect(c.isDirty.value).toBe(false);
        });
    });

    describe('saveRemote', () => {
        it('uploads the compiled VTT, clears the dirty flag, and removes localStorage', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const saveRemoteImpl = vi.fn().mockResolvedValue(undefined);
            const c = setup({
                getAccessToken: async () => 'tok',
                fetchRemote,
                saveRemoteImpl,
            });
            await c.load('sess-1');
            await flushMicrotasks();
            c.segments.value = [{ id: 'a', inSec: 0, outSec: 10, label: 'A' }];
            await nextTick();
            vi.advanceTimersByTime(60);
            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeTruthy();

            await c.saveRemote();

            const expectedVtt = exportChaptersVtt(c.segments.value);
            expect(saveRemoteImpl).toHaveBeenCalledWith('sess-1', 'en', expectedVtt, 'tok');
            expect(c.isDirty.value).toBe(false);
            expect(c.lastSavedAt.value).toBeInstanceOf(Date);
            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeNull();
        });

        it('keeps the dirty state when the upload fails', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const saveRemoteImpl = vi.fn().mockRejectedValue(new Error('500'));
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote, saveRemoteImpl });
            await c.load('sess-1');
            await flushMicrotasks();
            c.segments.value = [{ id: 'a', inSec: 0, outSec: 10 }];
            await nextTick();

            await expect(c.saveRemote()).rejects.toThrow('500');
            expect(c.isDirty.value).toBe(true);
            expect(c.isSaving.value).toBe(false);
        });
    });

    describe('discardLocal', () => {
        it('clears local storage and reloads from the server', async () => {
            localStorage.setItem(
                STORAGE_PREFIX + 'sess-1',
                JSON.stringify({
                    lang: 'en',
                    segments: [{ id: 'a', inSec: 0, outSec: 5, label: 'Local' }],
                    updatedAt: '2026-04-25T00:00:00Z',
                }),
            );
            const fetchRemote = vi.fn().mockResolvedValue({
                vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nServer\n',
            });
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-1');
            expect(c.isDirty.value).toBe(true);

            await c.discardLocal();

            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeNull();
            expect(c.isDirty.value).toBe(false);
            expect(c.segments.value[0].label).toBe('Server');
        });
    });

    describe('unload', () => {
        it('cancels pending autosave timers and resets state', async () => {
            const fetchRemote = vi.fn().mockResolvedValue(null);
            const c = setup({ getAccessToken: async () => 'tok', fetchRemote });
            await c.load('sess-1');
            await flushMicrotasks();
            c.segments.value = [{ id: 'a', inSec: 0, outSec: 5 }];
            await nextTick();

            c.unload();
            vi.advanceTimersByTime(200);

            // No write happened because the timer was cleared and activeSessionId is gone.
            expect(localStorage.getItem(STORAGE_PREFIX + 'sess-1')).toBeNull();
            expect(c.isLoaded.value).toBe(false);
        });
    });
});
