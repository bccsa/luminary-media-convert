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

    it('keeps asking after a 404, which is a race with ingest and not an answer', async () => {
        // This composable is only ever activated for a source the caller
        // already knows has a video track, so a 404 here means the request beat
        // the probe. Treating it as final — "this source will never have
        // frames" — left the timeline bare for the whole configure phase
        // whenever the first request landed mid-ingest.
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                headers: { get: () => null },
                text: async () => '',
            } as unknown as Response)
            .mockResolvedValue(respond(6, true));
        const s = useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        expect(s.complete.value).toBe(false);
        expect(s.hasFrames.value).toBe(false);

        await vi.advanceTimersByTimeAsync(3_000);
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(s.hasFrames.value).toBe(true);
        expect(s.complete.value).toBe(true);
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

    it('fetches the moment the encoder says it has sampled more', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        const refresh = ref<string | undefined>(undefined);
        useStoryboard({ url: url(), active: ref(true), refresh, fetcher });
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        refresh.value = '48';
        await settle();

        // No timer was advanced: the push is what fetched.
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('drops the timer to a slow parachute once something is pushing', async () => {
        // With a push signal the timer stops being how growth is noticed and is
        // only there to recover a stream that died without saying so.
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        useStoryboard({
            url: url(),
            active: ref(true),
            refresh: ref('1'),
            fetcher,
        });
        await settle();

        await vi.advanceTimersByTimeAsync(19_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('backs off on its own when there is nothing pushing', async () => {
        // No signal to react to, so the timer is the whole mechanism: quick
        // first, then slower as the pass drags on.
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        useStoryboard({ url: url(), active: ref(true), fetcher });
        await settle();

        await vi.advanceTimersByTimeAsync(3_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(4_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('follows up a push that landed mid-request as soon as that one lands', async () => {
        // The response being read may predate the frames the push announced, so
        // the push cannot simply be dropped — and handing it to the parachute
        // instead cost a 20-second wait for frames the encoder had already said
        // exist.
        let resolveFirst!: (r: Response) => void;
        const fetcher = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((r) => {
                        resolveFirst = r;
                    })
            )
            .mockResolvedValue(respond(9, false));
        const refresh = ref<string | undefined>(undefined);
        useStoryboard({ url: url(), active: ref(true), refresh, fetcher });
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        refresh.value = '9';
        await settle();
        expect(fetcher).toHaveBeenCalledTimes(1);

        resolveFirst(respond(3, false));
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('ignores a push once the storyboard is complete', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(25, true));
        const refresh = ref<string | undefined>(undefined);
        useStoryboard({ url: url(), active: ref(true), refresh, fetcher });
        await settle();

        refresh.value = '25-done';
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('ignores a refresh value that says nothing', async () => {
        // The signal goes empty when the poller restarts and has no count yet;
        // that is not the encoder reporting new frames.
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        const refresh = ref<string | undefined>('12');
        useStoryboard({ url: url(), active: ref(true), refresh, fetcher });
        await settle();

        refresh.value = undefined;
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('costs a fetch but no url churn when a push brings no new frames', async () => {
        const fetcher = vi.fn().mockResolvedValue(respond(3, false));
        const refresh = ref<string | undefined>(undefined);
        const s = useStoryboard({
            url: url(),
            active: ref(true),
            refresh,
            fetcher,
        });
        await settle();
        const afterFirst = s.versionedUrl.value;

        refresh.value = '3';
        await settle();

        expect(fetcher).toHaveBeenCalledTimes(2);
        // Same cues: moving the URL would make the timeline refetch and redraw
        // a filmstrip identical to the one already on screen.
        expect(s.versionedUrl.value).toBe(afterFirst);
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
