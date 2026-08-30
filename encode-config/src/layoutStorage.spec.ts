import { describe, expect, it } from 'vitest';
import { computeLayoutKey } from './layoutStorage';
import type { ProbeResult, VideoTrackInfo } from './types';

function video(overrides: Partial<VideoTrackInfo> = {}): VideoTrackInfo {
    return {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitrateKbps: 5000,
        frameRate: 25,
        ...overrides,
    };
}

function probe(videoTracks: VideoTrackInfo[]): ProbeResult {
    return {
        format: { duration: 120, bitrateKbps: 5000, formatName: 'mp4' },
        videoTracks,
        audioTracks: [
            {
                index: 0,
                codec: 'aac',
                bitrateKbps: 128,
                channels: 2,
                sampleRate: 48000,
            },
        ],
    };
}

/**
 * The fingerprint decides which saved track labels and languages come back for
 * a source. It is keyed on the media layout, so two sources that look the same
 * to it share a slot — which is fine until two genuinely different pictures are
 * both `720x576`.
 */
describe('computeLayoutKey', () => {
    it('says nothing extra about a square-pixel source', () => {
        // Every key written before display dimensions existed has to keep
        // matching, or every saved label is orphaned on upgrade. That is the
        // whole reason the token is conditional.
        expect(computeLayoutKey(probe([video()]), 'video')).toBe(
            'video|v:1920x1080:h264|a:aac:2:48000'
        );
    });

    it('is unchanged when the display size equals the coded size', () => {
        expect(
            computeLayoutKey(
                probe([video({ displayWidth: 1920, displayHeight: 1080 })]),
                'video'
            )
        ).toBe(computeLayoutKey(probe([video()]), 'video'));
    });

    it('separates 4:3 and 16:9 PAL SD, which used to share a slot', () => {
        const squarePal = probe([video({ width: 720, height: 576 })]);
        const widePal = probe([
            video({
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
            }),
        ]);

        expect(computeLayoutKey(squarePal, 'video')).toBe(
            'video|v:720x576:h264|a:aac:2:48000'
        );
        expect(computeLayoutKey(widePal, 'video')).toBe(
            'video|v:720x576@1024x576:h264|a:aac:2:48000'
        );
        expect(computeLayoutKey(squarePal, 'video')).not.toBe(
            computeLayoutKey(widePal, 'video')
        );
    });

    it('separates sources that correct on different axes', () => {
        const wide = probe([
            video({
                width: 720,
                height: 480,
                displayWidth: 960,
                displayHeight: 480,
            }),
        ]);
        const tall = probe([
            video({
                width: 720,
                height: 480,
                displayWidth: 720,
                displayHeight: 540,
            }),
        ]);

        expect(computeLayoutKey(wide, 'video')).not.toBe(
            computeLayoutKey(tall, 'video')
        );
    });

    it('marks each angle of a multi-track source independently', () => {
        expect(
            computeLayoutKey(
                probe([
                    video({ index: 0, width: 1920, height: 1080 }),
                    video({
                        index: 1,
                        width: 720,
                        height: 576,
                        displayWidth: 1024,
                        displayHeight: 576,
                    }),
                ]),
                'video'
            )
        ).toBe(
            'video|v:1920x1080:h264,720x576@1024x576:h264|a:aac:2:48000'
        );
    });

    it('leaves the audio-only key alone, which has no video in it', () => {
        expect(
            computeLayoutKey(
                probe([
                    video({
                        width: 720,
                        height: 576,
                        displayWidth: 1024,
                        displayHeight: 576,
                    }),
                ]),
                'audio'
            )
        ).toBe('audio|a:aac:2:48000');
    });
});
