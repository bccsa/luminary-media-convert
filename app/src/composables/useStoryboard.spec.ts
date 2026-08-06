import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useStoryboard } from './useStoryboard';

function vtt(cues: number): string {
    let body = 'WEBVTT\n\n';
    for (let i = 0; i < cues; i++) {
        body += `00:00:0${i}.000 --> 00:00:0${i + 1}.000\nsprite_001.webp\n\n`;
    }
    return body;
}

function respond(cues: number, complete: boolean) {
    return {
        ok: true,
        headers: { get: () => (complete ? 'true' : 'false') },
        text: async () => vtt(cues),
    } as unknown as Response;
}

/** Let the poll's promise chain settle before asserting. */
async function settle() {
    for (let i = 0; i < 4; i++) await nextTick();
}

describe('useStoryboard', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const url = () => ref<string | null>('https://api/thumbnails.vtt?token=t');

    it('reports frames as soon as any exist', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        expect(s.hasFrames.value).toBe(true);
        expect(s.complete.value).toBe(false);
    });

    it('keeps asking while the storyboard is still being built', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3_000);
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('stops once the storyboard is complete', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(25, true));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        expect(s.complete.value).toBe(true);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('moves the url on only when there are more cues to draw', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(respond(3, false))
            .mockResolvedValueOnce(respond(3, false))
            .mockResolvedValue(respond(9, false));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();
        const afterFirst = s.versionedUrl.value;

        await vi.advanceTimersByTimeAsync(3_000);
        await settle();
        // Same cue count: refetching the timeline would show nothing new.
        expect(s.versionedUrl.value).toBe(afterFirst);

        await vi.advanceTimersByTimeAsync(5_000);
        await settle();
        expect(s.versionedUrl.value).not.toBe(afterFirst);
    });

    it('leaves the url alone until there is something to report', () => {
        const fetcher = vi.fn().mockResolvedValue(respond(0, false));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });

        expect(s.versionedUrl.value).toBe('https://api/thumbnails.vtt?token=t');
    });

    it('does not poll when there is no storyboard to follow', async () => {
        const fetcher = vi.fn();
        useStoryboard({ url: ref(null), active: ref(true), fetcher });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not poll once the encode owns the storyboard', async () => {
        const fetcher = vi.fn();
        useStoryboard({ url: url(), active: ref(false), fetcher });
        await settle();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('gives up when the source has no storyboard at all', async () => {
        // 404 is the API saying this source has no video track to sample. It is
        // the one failure that will not resolve itself, so the watch ends and
        // nothing claims frames are on their way — an audio-only session used
        // to show "Generating thumbnails…" for its whole life.
        const fetcher = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            headers: { get: () => null },
            text: async () => '',
        } as unknown as Response);
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        expect(s.complete.value).toBe(true);
        expect(s.hasFrames.value).toBe(false);
        expect(s.pending.value).toBe(false);

        // And it stays given up rather than resuming on the next tick.
        await vi.advanceTimersByTimeAsync(30_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps trying after a failed request', async () => {
        // A network error, unlike a 404, may well clear on the next attempt —
        // the first sprites can still be being written.
        const fetcher = vi
            .fn()
            .mockRejectedValueOnce(new Error('network'))
            .mockResolvedValue(respond(5, true));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        await vi.advanceTimersByTimeAsync(3_000);
        await settle();

        expect(s.complete.value).toBe(true);
    });

    it('reports pending only while frames are still coming', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(4, false));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();
        expect(s.pending.value).toBe(true);

        fetcher.mockResolvedValue(respond(29, true));
        await vi.advanceTimersByTimeAsync(3_000);
        await settle();

        expect(s.pending.value).toBe(false);
    });
});
