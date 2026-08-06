import { describe, expect, it } from 'vitest';
import { retimeStoryboardVtt } from './storyboardVtt';

const URL_ = 'https://api.test/api/sessions/s1/thumbnails/thumbnails.vtt';

/** Cues of `step` seconds each, tiled left to right across one sprite sheet. */
function sourceVtt(count: number, step = 10): string {
    const stamp = (s: number) =>
        `00:00:${String(s).padStart(2, '0')}.000`;
    const blocks = Array.from({ length: count }, (_, i) =>
        `${stamp(i * step)} --> ${stamp((i + 1) * step)}\nsprite.jpg#xywh=${i * 160},0,160,90`
    );
    return ['WEBVTT', '', ...blocks].join('\n\n');
}

const cueTimes = (vtt: string) =>
    vtt
        .split('\n')
        .filter((l) => l.includes(' --> '))
        .map((l) => l.trim());

describe('retimeStoryboardVtt', () => {
    it('drops cues whose frames were cut', () => {
        // Keep 0-10 and 30-40 of a 60s source: the four cues covering 10-30 and
        // 40-60 show material that will not exist in the output.
        const out = retimeStoryboardVtt(sourceVtt(6), URL_, [
            { inSec: 0, outSec: 10 },
            { inSec: 30, outSec: 40 },
        ] as never);

        expect(cueTimes(out)).toHaveLength(2);
    });

    it('lays the retained ranges end to end', () => {
        // The 30-40 cue becomes the second 10 seconds of the output, not the
        // fourth — which is the whole point: the ruler describes the programme.
        const out = retimeStoryboardVtt(sourceVtt(6), URL_, [
            { inSec: 0, outSec: 10 },
            { inSec: 30, outSec: 40 },
        ] as never);

        expect(cueTimes(out)).toEqual([
            '00:00:00.000 --> 00:00:10.000',
            '00:00:10.000 --> 00:00:20.000',
        ]);
    });

    it('truncates a cue at the cut rather than spilling it across', () => {
        // A 10s cue starting at 0 in a range that ends at 4s describes the
        // output only for those 4 seconds.
        const out = retimeStoryboardVtt(sourceVtt(2), URL_, [
            { inSec: 0, outSec: 4 },
        ] as never);

        expect(cueTimes(out)).toEqual(['00:00:00.000 --> 00:00:04.000']);
    });

    it('resolves sprite references to absolute urls', () => {
        // Served to the editor as a blob, a relative path has no base left.
        const out = retimeStoryboardVtt(sourceVtt(1), URL_, [
            { inSec: 0, outSec: 10 },
        ] as never);

        expect(out).toContain(
            'https://api.test/api/sessions/s1/thumbnails/sprite.jpg#xywh=0,0,160,90'
        );
    });

    it('keeps the sprite crop untouched', () => {
        const out = retimeStoryboardVtt(sourceVtt(3), URL_, [
            { inSec: 20, outSec: 30 },
        ] as never);

        expect(out).toContain('#xywh=320,0,160,90');
    });

    it('produces a parseable vtt', () => {
        const out = retimeStoryboardVtt(sourceVtt(3), URL_, [
            { inSec: 0, outSec: 30 },
        ] as never);

        expect(out.startsWith('WEBVTT\n')).toBe(true);
        expect(cueTimes(out)).toHaveLength(3);
    });

    it('clips a cue straddling the in-point instead of discarding it', () => {
        // The regression: a cue was kept only when its *start* fell inside a
        // retained range, so a cut landing mid-cue — which is the normal case,
        // since cuts do not respect the sampling interval — threw away the only
        // frame covering the first seconds of the programme. The filmstrip then
        // opened on a blank stretch, which read as the kept selection having
        // been deleted.
        const out = retimeStoryboardVtt(sourceVtt(3), URL_, [
            { inSec: 4, outSec: 20 },
        ] as never);

        expect(cueTimes(out)).toEqual([
            // 4-10 of the source is the first 6 seconds of the output...
            '00:00:00.000 --> 00:00:06.000',
            // ...and the whole 10-20 cue follows it.
            '00:00:06.000 --> 00:00:16.000',
        ]);
        // The clipped cue still shows the frame sampled at 0, not the next one.
        expect(out).toContain('#xywh=0,0,160,90');
    });

    it('emits a cue either side of a cut it spans', () => {
        // Keeping 0-5 and 6-10 leaves both halves of the 0-10 cue in the output,
        // now adjacent. Both are still that frame, so both are drawn.
        const out = retimeStoryboardVtt(sourceVtt(1), URL_, [
            { inSec: 0, outSec: 5 },
            { inSec: 6, outSec: 10 },
        ] as never);

        expect(cueTimes(out)).toEqual([
            '00:00:00.000 --> 00:00:05.000',
            '00:00:05.000 --> 00:00:09.000',
        ]);
    });

    it('returns a header-only vtt when nothing survives the trim', () => {
        // Better than leaving the previous strip in place, which would show
        // frames for a timeline that no longer exists.
        const out = retimeStoryboardVtt(sourceVtt(2), URL_, [
            { inSec: 100, outSec: 110 },
        ] as never);

        expect(cueTimes(out)).toHaveLength(0);
        expect(out.startsWith('WEBVTT')).toBe(true);
    });
});
