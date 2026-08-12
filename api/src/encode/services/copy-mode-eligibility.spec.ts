import { copyModeRejection } from './copy-mode-eligibility.js';
import type { ProbeResult } from './probe.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

/**
 * A source that qualifies for copy mode: every stream starts together, and the
 * keyframes are a regular two seconds — which divides six-second segments
 * exactly. Each test breaks one rule.
 */
function makeProbeResult(
    videoOverrides: Partial<ProbeResult['videoTracks'][number]> = {},
    audioOverrides: Partial<ProbeResult['audioTracks'][number]> = {}
): ProbeResult {
    return {
        format: { duration: 120, bitrateKbps: 5000, formatName: 'mp4' },
        videoTracks: [
            {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrateKbps: 5000,
                frameRate: 30,
                startTime: 0,
                gopFrames: 60,
                gopSeconds: 2,
                gopRegular: true,
                ...videoOverrides,
            },
        ],
        audioTracks: [
            {
                index: 0,
                codec: 'aac',
                bitrateKbps: 128,
                channels: 2,
                sampleRate: 48000,
                startTime: 0,
                ...audioOverrides,
            },
        ],
    };
}

function makeConfig(overrides: Partial<EncodeConfigDto> = {}): EncodeConfigDto {
    return {
        type: 'video',
        segmentDuration: 6,
        videoRenditions: [
            {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: true,
                sourceTrackIndex: 0,
                audioGroupId: 'hd',
            },
        ],
        audioGroups: [
            {
                id: 'hd',
                audioBitrateKbps: 128,
                channels: 2,
                audioCodec: 'aac',
                sourceTrackIndex: 0,
            },
        ],
        ...overrides,
    };
}

describe('copyModeRejection', () => {
    it('allows a source that qualifies', () => {
        expect(copyModeRejection(makeProbeResult(), makeConfig())).toBeNull();
    });

    it('says nothing about a config with no copy renditions', () => {
        const config = makeConfig();
        config.videoRenditions![0].copyStream = false;
        // Not even for a source that would fail every rule.
        expect(
            copyModeRejection(
                makeProbeResult({ gopRegular: false }, { startTime: 1 }),
                config
            )
        ).toBeNull();
    });

    it('says nothing about an audio-only encode', () => {
        expect(
            copyModeRejection(
                makeProbeResult(),
                makeConfig({ type: 'audio', videoRenditions: undefined })
            )
        ).toBeNull();
    });

    describe('start alignment', () => {
        it('refuses a track the encode will have to seek past', () => {
            // Audio a tenth of a second late pulls every stream forward to meet
            // it, and a seek over a copied stream lands on its own keyframe.
            const reason = copyModeRejection(
                makeProbeResult({}, { startTime: 0.1 }),
                makeConfig()
            );
            expect(reason).toMatch(
                /Video track 0 starts 100 ms before the latest stream/
            );
            expect(reason).toMatch(/re-encode this rendition instead/);
        });

        it('allows the track everything else is aligned to', () => {
            // It is seeked exactly; the others are the ones being moved.
            expect(
                copyModeRejection(
                    makeProbeResult({ startTime: 0.1 }, { startTime: 0 }),
                    makeConfig()
                )
            ).toBeNull();
        });

        it('ignores a spread the encode will not act on', () => {
            // Under the 20 ms tolerance nothing is seeked, so nothing is cut at
            // a keyframe it did not ask for.
            expect(
                copyModeRejection(
                    makeProbeResult({}, { startTime: 0.015 }),
                    makeConfig()
                )
            ).toBeNull();
        });

        it('ignores a late stream the config never opens', () => {
            const probeResult = makeProbeResult();
            probeResult.audioTracks.push({
                index: 1,
                codec: 'aac',
                bitrateKbps: 128,
                channels: 2,
                sampleRate: 48000,
                startTime: 5,
            });
            // Nothing maps track 1, so it cannot drag the encode forward.
            expect(copyModeRejection(probeResult, makeConfig())).toBeNull();
        });
    });

    describe('keyframe cadence', () => {
        it('refuses a GOP that does not divide the segment', () => {
            // 2.5s into 6s gives chunks of 5s and 7.5s.
            const reason = copyModeRejection(
                makeProbeResult({ gopFrames: 75, gopSeconds: 2.5 }),
                makeConfig()
            );
            expect(reason).toMatch(
                /keyframe interval \(2\.5s\) does not fit 6s segments/
            );
        });

        it('allows a GOP the segment is a whole multiple of', () => {
            // 1s GOPs, 6s segments.
            expect(
                copyModeRejection(
                    makeProbeResult({ gopFrames: 30, gopSeconds: 1 }),
                    makeConfig()
                )
            ).toBeNull();
        });

        it('does not fail an NTSC source over a rounded frame', () => {
            // 6s at 29.97 is 179.82 frames, and 2s of GOP is 59.94 — compared
            // in seconds that never divides, which is why the comparison is in
            // frames with a frame either side of the boundary allowed.
            expect(
                copyModeRejection(
                    makeProbeResult({
                        frameRate: 29.97,
                        gopFrames: 60,
                        gopSeconds: 2.002,
                    }),
                    makeConfig()
                )
            ).toBeNull();
        });

        it('refuses an irregular cadence', () => {
            expect(
                copyModeRejection(
                    makeProbeResult({ gopRegular: false }),
                    makeConfig()
                )
            ).toMatch(/keyframe structure could not be determined/);
        });

        it('refuses a cadence that was never probed', () => {
            expect(
                copyModeRejection(
                    makeProbeResult({
                        gopFrames: undefined,
                        gopSeconds: undefined,
                        gopRegular: undefined,
                    }),
                    makeConfig()
                )
            ).toMatch(/keyframe structure could not be determined/);
        });

        it('refuses when there is no probe result at all', () => {
            // A session that reached here without one is not a reason to guess.
            expect(copyModeRejection(undefined, makeConfig())).toMatch(
                /keyframe structure could not be determined/
            );
        });
    });

    it('names the track that failed, not the first one', () => {
        const probeResult = makeProbeResult();
        probeResult.videoTracks.push({
            ...probeResult.videoTracks[0],
            index: 1,
            gopRegular: false,
        });
        const config = makeConfig();
        config.videoRenditions!.push({
            width: 1920,
            height: 1080,
            videoBitrateKbps: 5000,
            copyStream: true,
            sourceTrackIndex: 1,
            audioGroupId: 'hd',
        });

        expect(copyModeRejection(probeResult, config)).toMatch(
            /^Video track 1/
        );
    });
});
