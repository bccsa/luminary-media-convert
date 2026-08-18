import { describe, it, expect } from 'vitest';
import { mergeControls, DEFAULT_CONTROLS } from '../src/controls';
import { snapSkipSeconds, buildVideoJsOptions } from '../src/vjs/playerOptions';

describe('mergeControls', () => {
    it('is the library default when nothing is overridden', () => {
        expect(mergeControls()).toEqual(DEFAULT_CONTROLS);
        expect(mergeControls({})).toEqual(DEFAULT_CONTROLS);
    });

    it('takes a sparse override and inherits the rest', () => {
        // So adding an option later cannot change what an existing caller gets.
        expect(mergeControls({ audioMenu: false })).toEqual({
            ...DEFAULT_CONTROLS,
            audioMenu: false,
        });
    });

    it('honours 0 as "no button"', () => {
        expect(mergeControls({ skipForwardSeconds: 0 }).skipForwardSeconds).toBe(0);
    });

    it('ignores an interval that cannot be seeked to', () => {
        // NaN would travel into seek() and strand the video; a negative forward
        // skip is not a configuration anyone means.
        expect(mergeControls({ skipForwardSeconds: NaN }).skipForwardSeconds).toBe(10);
        expect(mergeControls({ skipBackSeconds: -5 }).skipBackSeconds).toBe(10);
        expect(
            mergeControls({ skipForwardSeconds: '30' as unknown as number }).skipForwardSeconds,
        ).toBe(10);
        expect(mergeControls({ audioMenu: 1 as unknown as boolean }).audioMenu).toBe(true);
    });
});

describe('snapSkipSeconds', () => {
    it('passes through the intervals video.js can draw', () => {
        expect(snapSkipSeconds(5)).toBe(5);
        expect(snapSkipSeconds(10)).toBe(10);
        expect(snapSkipSeconds(30)).toBe(30);
    });

    it('snaps anything else to the nearest, rather than losing the button', () => {
        // An unsnapped 15 renders nothing at all in video.js 8.
        expect(snapSkipSeconds(15)).toBe(10);
        expect(snapSkipSeconds(25)).toBe(30);
        expect(snapSkipSeconds(1)).toBe(5);
        expect(snapSkipSeconds(120)).toBe(30);
    });

    it('takes the shorter interval when two are equally near', () => {
        // 20 sits exactly between 10 and 30; a jump shorter than asked for is
        // the recoverable direction.
        expect(snapSkipSeconds(20)).toBe(10);
        expect(snapSkipSeconds(7.5)).toBe(5);
    });

    it('says "no button" for 0 and for values that are not intervals', () => {
        expect(snapSkipSeconds(0)).toBeUndefined();
        expect(snapSkipSeconds(-10)).toBeUndefined();
        expect(snapSkipSeconds(NaN)).toBeUndefined();
        expect(snapSkipSeconds(Infinity)).toBeUndefined();
    });
});

describe('buildVideoJsOptions', () => {
    it('gives the buttons the same number as their labels', () => {
        // The snapped value is what is seeked, so 15 is a 10-second button that
        // jumps 10 — not a 15-second jump behind a "10" icon.
        const options = buildVideoJsOptions(
            mergeControls({ skipForwardSeconds: 15, skipBackSeconds: 30 }),
        );

        expect(options.controlBar.skipButtons).toEqual({ forward: 10, backward: 30 });
        expect(options.controlBar.children).toContain('skipForward');
        expect(options.controlBar.children).toContain('skipBackward');
    });

    it('omits a skip button entirely when its interval is 0', () => {
        const options = buildVideoJsOptions(
            mergeControls({ skipForwardSeconds: 0, skipBackSeconds: 0 }),
        );

        expect(options.controlBar.skipButtons).toEqual({});
        expect(options.controlBar.children).not.toContain('skipForward');
        expect(options.controlBar.children).not.toContain('skipBackward');
    });

    it('drops only the audio menu when the host has its own', () => {
        const children = buildVideoJsOptions(mergeControls({ audioMenu: false })).controlBar
            .children;

        expect(children).not.toContain('audioTrackButton');
        expect(children).toContain('subsCapsButton');
        expect(children).toContain('playToggle');
    });

    it('drops the subtitle menu when the host has never had one', () => {
        const children = buildVideoJsOptions(mergeControls({ subtitlesMenu: false })).controlBar
            .children;

        expect(children).not.toContain('subsCapsButton');
        expect(children).toContain('audioTrackButton');
    });

    it('keeps the subtitle and PiP buttons in the fixed child list', () => {
        // Control-bar children are fixed at construction: a source's text tracks
        // are not known then, and the player may switch to YouTube and back.
        const children = buildVideoJsOptions(DEFAULT_CONTROLS).controlBar.children;

        expect(children).toContain('subsCapsButton');
        expect(children).toContain('pictureInPictureToggle');
    });

    it('drives VHS itself and never autoplays', () => {
        // What it is handed is a munged blob playlist no native pipeline would
        // resolve; autoplay is the host's call, made after a gesture.
        const options = buildVideoJsOptions(DEFAULT_CONTROLS);

        expect(options.html5.vhs.overrideNative).toBe(true);
        expect(options.autoplay).toBe(false);
    });
});
