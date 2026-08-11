// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionStatusResponse } from '../types';

const { getSessionStatus, subscribeSessionEvents, close } = vi.hoisted(() => ({
    getSessionStatus: vi.fn(),
    subscribeSessionEvents: vi.fn(),
    close: vi.fn(),
}));

vi.mock('../api', () => ({
    getSessionStatus,
    subscribeSessionEvents,
}));

import { useSessionPoller } from './useSessionPoller';

/** Whatever the stream or the status endpoint reports, in the one shape both use. */
function update(fields: Partial<SessionStatusResponse>): SessionStatusResponse {
    return { status: 'encoding', ...fields } as SessionStatusResponse;
}

/** Push an event the way the API's SSE stream would. */
function emit(fields: Partial<SessionStatusResponse>) {
    const onEvent = subscribeSessionEvents.mock.calls[0][2];
    onEvent(update(fields));
}

function flush() {
    return new Promise<void>((r) => setTimeout(r, 0));
}

describe('useSessionPoller', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSessionStatus.mockResolvedValue(update({ status: 'uploaded' }));
        subscribeSessionEvents.mockReturnValue({ close });
    });

    async function started() {
        const poller = useSessionPoller();
        poller.start('sess-1', 'sess_token');
        await flush();
        return poller;
    }

    describe('storyboard progress', () => {
        it('reports how far the encoder has sampled the source', async () => {
            // The filmstrip refetches off this count, so a session that never
            // hears it draws its frames only when the slow fallback finds them.
            const poller = await started();

            emit({ status: 'uploaded', storyboardThumbCount: 41 });

            expect(poller.storyboardThumbCount.value).toBe(41);
            expect(poller.storyboardComplete.value).toBeUndefined();
        });

        it('reports the finished sampling pass', async () => {
            const poller = await started();

            emit({
                status: 'uploaded',
                storyboardThumbCount: 96,
                storyboardComplete: true,
            });

            expect(poller.storyboardComplete.value).toBe(true);
        });

        it('takes the count from the status response too, for a dropped stream', async () => {
            // The fallback poll is the only thing watching once SSE has gone,
            // which is precisely when the client still needs to hear this.
            getSessionStatus.mockResolvedValue(
                update({
                    status: 'uploaded',
                    storyboardThumbCount: 12,
                    storyboardComplete: false,
                })
            );

            const poller = await started();

            expect(poller.storyboardThumbCount.value).toBe(12);
        });

        it('does not forget the count on a later event that omits it', async () => {
            // Frames do not go away because an encode-progress event had
            // nothing to say about them.
            const poller = await started();
            emit({ status: 'uploaded', storyboardThumbCount: 41 });

            emit({ status: 'encoding', progress: 20 });

            expect(poller.storyboardThumbCount.value).toBe(41);
        });
    });

    describe('fields that outlive the event carrying them', () => {
        it('keeps the ingest total once the probe has reported it', async () => {
            getSessionStatus.mockResolvedValue(update({ status: 'uploading' }));
            const poller = await started();
            emit({ status: 'uploading', ingestTotalBytes: 524_288_000 });

            emit({ status: 'uploading', progress: 60 });

            expect(poller.ingestTotalBytes.value).toBe(524_288_000);
        });

        it('keeps the playback URL published at encode start', async () => {
            // Settled the moment encoding starts and never changed after; the
            // progress events that follow simply do not mention it.
            const poller = await started();
            emit({ status: 'encoding', hlsUrl: 'https://cdn/x/master.m3u8' });

            emit({ status: 'encoding', progress: 40 });

            expect(poller.hlsUrl.value).toBe('https://cdn/x/master.m3u8');
        });

        it('keeps the submitted trim ranges, which are config and not progress', async () => {
            const poller = await started();
            emit({
                status: 'encoding',
                trimSegments: [{ inSec: 10, outSec: 20 }],
            });

            emit({ status: 'encoding', progress: 55 });

            expect(poller.trimSegments.value).toEqual([
                { inSec: 10, outSec: 20 },
            ]);
        });
    });

    it('passes the finalize phase through untouched', async () => {
        // An identifier, not a sentence: the poller carries it verbatim and the
        // view owns the wording, so an unrecognised one can render nothing
        // rather than printing a raw key at the user.
        const poller = await started();

        emit({
            status: 'encoding',
            pipelineProgress: { encoding: 100, phase: 'waveform' },
        });

        expect(poller.pipelineProgress.value?.phase).toBe('waveform');
    });

    it('drops an event describing an earlier stage than the one already reached', async () => {
        // Events and the fallback poll can cross; the older one must not walk
        // the UI backwards into a phase it has left.
        const poller = await started();
        emit({ status: 'encoding', progress: 70 });

        emit({ status: 'uploaded', progress: 0, storyboardThumbCount: 3 });

        expect(poller.status.value).toBe('encoding');
        expect(poller.progress.value).toBe(70);
        expect(poller.storyboardThumbCount.value).toBeUndefined();
    });

    it('starts a session from a clean slate', async () => {
        const poller = await started();
        emit({
            status: 'encoding',
            progress: 70,
            hlsUrl: 'https://cdn/x/master.m3u8',
            storyboardThumbCount: 41,
            storyboardComplete: true,
            ingestTotalBytes: 1_000,
            trimSegments: [{ inSec: 1, outSec: 2 }],
            pipelineProgress: { encoding: 70 },
        });

        // Asserted before the new session's first status lands, so what is seen
        // is the reset itself and not whatever the encoder answered.
        poller.start('sess-2', 'sess_token_2');

        expect(poller.status.value).toBeNull();
        expect(poller.progress.value).toBeUndefined();
        expect(poller.hlsUrl.value).toBeUndefined();
        expect(poller.storyboardThumbCount.value).toBeUndefined();
        expect(poller.storyboardComplete.value).toBeUndefined();
        expect(poller.ingestTotalBytes.value).toBeUndefined();
        expect(poller.trimSegments.value).toBeUndefined();
        expect(poller.pipelineProgress.value).toBeUndefined();
    });

    it('stops the stream once the session reaches a terminal status', async () => {
        const poller = await started();

        emit({ status: 'completed', masterPlaylist: 'master.m3u8' });
        await flush();

        expect(close).toHaveBeenCalled();
        expect(poller.polling.value).toBe(false);
        // The final read closes the gap between the last event and the record
        // the encoder actually kept.
        expect(getSessionStatus).toHaveBeenCalledTimes(2);
    });
});
