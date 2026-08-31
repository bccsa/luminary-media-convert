import { describe, expect, it } from 'vitest';
import {
    copyModeBlockedReason,
    latestStreamStart,
    quickTrimBlockedReason,
} from './copyMode';
import type { VideoTrackInfo } from './types';

/** 25 fps, 2 s GOP — divides 6 s segments exactly, so cadence never objects. */
function goodCadenceTrack(
    overrides: Partial<VideoTrackInfo> = {}
): VideoTrackInfo {
    return {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitrateKbps: 5000,
        frameRate: 25,
        gopFrames: 50,
        gopSeconds: 2,
        gopRegular: true,
        startTime: 0.06,
        ...overrides,
    };
}

describe('quickTrimBlockedReason', () => {
    it('allows a track the alignment rule refuses', () => {
        // The reference source: streams starting 0.06 / 0.62 / 0.98 s apart. A
        // straight copy would be seeked to 0.98 and land on a keyframe instead;
        // a quick cut splices each stream on its own grid and never seeks.
        const track = goodCadenceTrack({ startTime: 0.06 });
        const latestStart = 0.98;

        expect(copyModeBlockedReason(track, latestStart, 6)).toMatch(
            /starts 920 ms before the latest stream/
        );
        expect(quickTrimBlockedReason(track, 6)).toBeNull();
    });

    it('refuses an unknown keyframe cadence exactly as the full rule does', () => {
        const track = goodCadenceTrack({
            gopRegular: false,
            gopFrames: 50,
        });

        const expected =
            "This track's keyframe structure could not be determined — " +
            're-encode this rendition instead.';
        expect(copyModeBlockedReason(track, 0, 6)).toBe(expected);
        expect(quickTrimBlockedReason(track, 6)).toBe(expected);
    });

    it('refuses a keyframe interval that does not fit the segments', () => {
        // 2.5 s GOP into 6 s segments: 150 frames into 150 gives 5 s and 7.5 s
        // segments no target duration describes.
        const track = goodCadenceTrack({
            frameRate: 25,
            gopFrames: 62,
            gopSeconds: 2.48,
        });

        const expected =
            "This track's keyframe interval (2.48s) does not fit 6s " +
            'segments — re-encode this rendition instead.';
        expect(copyModeBlockedReason(track, 0, 6)).toBe(expected);
        expect(quickTrimBlockedReason(track, 6)).toBe(expected);
    });

    it('keeps the full rule tolerant of a track that is the alignment target', () => {
        const track = goodCadenceTrack({ startTime: 0.98 });
        expect(copyModeBlockedReason(track, 0.98, 6)).toBeNull();
        expect(quickTrimBlockedReason(track, 6)).toBeNull();
    });
});

describe('latestStreamStart', () => {
    it('reports the seek target for a mutually offset source', () => {
        expect(
            latestStreamStart({
                format: { duration: 60, bitrateKbps: 6000, formatName: 'mov' },
                videoTracks: [
                    goodCadenceTrack({ index: 0, startTime: 0.06 }),
                    goodCadenceTrack({ index: 1, startTime: 0.62 }),
                ],
                audioTracks: [
                    {
                        index: 0,
                        codec: 'aac',
                        bitrateKbps: 128,
                        channels: 2,
                        sampleRate: 48000,
                        startTime: 0.98,
                    },
                ],
            })
        ).toBeCloseTo(0.98);
    });
});

describe('copy mode and H.265', () => {
    // Mirrors the API's own refusal. Enforced there; refused here so the form
    // says no before a job is submitted rather than after.
    it('refuses to copy an HEVC track', () => {
        const reason = copyModeBlockedReason(
            goodCadenceTrack({ codec: 'hevc' }),
            0,
            6
        );
        expect(reason).toMatch(/HEVC/);
        expect(reason).toMatch(/re-encode/);
    });

    it('refuses it on the quick-cut path too', () => {
        expect(
            quickTrimBlockedReason(goodCadenceTrack({ codec: 'hevc' }), 6)
        ).toMatch(/HEVC/);
    });

    it('recognises the codec however it is spelled', () => {
        for (const codec of ['hevc', 'h265', 'H.265', 'X265']) {
            expect(
                copyModeBlockedReason(goodCadenceTrack({ codec }), 0, 6)
            ).toMatch(/cannot be copied/);
        }
    });

    it('still allows H.264 to be copied', () => {
        expect(
            copyModeBlockedReason(goodCadenceTrack({ codec: 'h264' }), 0, 6)
        ).toBeNull();
    });
});
