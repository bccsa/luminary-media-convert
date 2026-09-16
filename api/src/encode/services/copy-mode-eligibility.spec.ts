import {
    copyModeRejection,
    quickTrimGateRejection,
} from './copy-mode-eligibility.js';
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

describe('quickTrimGateRejection', () => {
    it('accepts a mutually offset source the full copy gate refuses', () => {
        // Streams starting 0.9 s apart: copyModeRejection refuses this (the
        // alignment rule), but a quick cut splices each stream on its own
        // grid and never seeks to a shared offset.
        const probeResult = makeProbeResult(
            { startTime: 0.06 },
            { startTime: 0.98 }
        );
        const config = makeConfig();

        expect(copyModeRejection(probeResult, config)).toMatch(/out of sync/);
        expect(quickTrimGateRejection(probeResult, config)).toBeNull();
    });

    it('still refuses an unknown or irregular keyframe cadence', () => {
        expect(
            quickTrimGateRejection(
                makeProbeResult({ gopRegular: false }),
                makeConfig()
            )
        ).toMatch(/keyframe structure could not be determined/);
        expect(quickTrimGateRejection(undefined, makeConfig())).toMatch(
            /keyframe structure could not be determined/
        );
    });

    it('still refuses a cadence that does not fit the segment length', () => {
        expect(
            quickTrimGateRejection(
                makeProbeResult({ gopFrames: 75, gopSeconds: 2.5 }),
                makeConfig()
            )
        ).toMatch(/does not fit/);
    });

    it('has nothing to say without copy renditions or for audio type', () => {
        const noCopy = makeConfig();
        noCopy.videoRenditions![0].copyStream = false;
        expect(quickTrimGateRejection(makeProbeResult(), noCopy)).toBeNull();
        expect(
            quickTrimGateRejection(
                makeProbeResult(),
                makeConfig({ type: 'audio', videoRenditions: undefined })
            )
        ).toBeNull();
    });
});

describe('copy mode and H.265', () => {
    // A copy hands the source's bytes straight to the muxer, so a copied HEVC
    // track is H.265 in the output of a build that has no H.265 encoder.
    it('refuses to copy an HEVC track', () => {
        const reason = copyModeRejection(
            makeProbeResult({ codec: 'hevc' }),
            makeConfig()
        );
        expect(reason).toMatch(/HEVC/);
        expect(reason).toMatch(/re-encode/);
    });

    it('refuses it on the quick-cut path too', () => {
        expect(
            quickTrimGateRejection(
                makeProbeResult({ codec: 'hevc' }),
                makeConfig()
            )
        ).toMatch(/HEVC/);
    });

    it('recognises the codec however it is spelled', () => {
        for (const codec of ['hevc', 'h265', 'H.265', 'X265']) {
            expect(
                copyModeRejection(makeProbeResult({ codec }), makeConfig())
            ).toMatch(/cannot be copied/);
        }
    });

    // The refusal is about passthrough alone. Reading an HEVC source in order
    // to transcode it to H.264 stays supported, so a config that re-encodes
    // must not be blocked.
    it('allows an HEVC source that is being re-encoded', () => {
        const config = makeConfig();
        config.videoRenditions![0].copyStream = false;
        expect(
            copyModeRejection(makeProbeResult({ codec: 'hevc' }), config)
        ).toBeNull();
    });

    it('still allows H.264 to be copied', () => {
        expect(
            copyModeRejection(makeProbeResult({ codec: 'h264' }), makeConfig())
        ).toBeNull();
    });
});

/**
 * The shape rule — with the codec rule above it, one of the two that hold
 * however the copy is being used. A copied stream's sample aspect ratio is in
 * its bitstream: the muxer never sees a frame, so nothing between the source
 * and the playlist can square it. HLS output here is always square-pixel, so an
 * anamorphic track has to be re-encoded to become one.
 */
describe('non-square pixels', () => {
    const anamorphic = {
        width: 720,
        height: 576,
        displayWidth: 1024,
        displayHeight: 576,
    };

    it('refuses a copy of a PAL SD track carrying 16:9', () => {
        expect(
            copyModeRejection(makeProbeResult(anamorphic), makeConfig())
        ).toBe(
            'Video track 0 stores non-square pixels (720x576 shown 1024x576); ' +
                "copy mode hands the source's own bytes to the muxer, which " +
                'cannot square them — re-encode this rendition instead.'
        );
    });

    it('refuses the quick cut too, which the cadence rules would have allowed', () => {
        // The point of the rule sitting in the shared per-track check: a quick
        // cut splices the same bitstream and inherits the same ratio, so a
        // lossless cut of an anamorphic source is anamorphic output.
        const probe = makeProbeResult(anamorphic);
        expect(quickTrimGateRejection(probe, makeConfig())).toMatch(
            /non-square pixels/
        );
    });

    it('refuses ahead of the alignment and cadence rules', () => {
        // Whichever other rule a track also breaks, the shape is the one it can
        // do nothing about — so it is the reason the user is given.
        const probe = makeProbeResult({
            ...anamorphic,
            gopRegular: false,
            startTime: 0,
        });
        expect(copyModeRejection(probe, makeConfig())).toMatch(
            /non-square pixels/
        );
    });

    it('names the other axis for a source that corrects on height', () => {
        expect(
            copyModeRejection(
                makeProbeResult({
                    width: 720,
                    height: 480,
                    displayWidth: 720,
                    displayHeight: 540,
                }),
                makeConfig()
            )
        ).toMatch(/\(720x480 shown 720x540\)/);
    });

    it('allows a copy of a square-pixel track', () => {
        expect(
            copyModeRejection(
                makeProbeResult({ displayWidth: 1920, displayHeight: 1080 }),
                makeConfig()
            )
        ).toBeNull();
    });

    it('allows a copy on a probe from before the fields existed', () => {
        // A session restored across the upgrade has no display dimensions. It
        // must not start refusing copies it allowed yesterday.
        const probe = makeProbeResult();
        delete probe.videoTracks[0].displayWidth;
        delete probe.videoTracks[0].displayHeight;
        expect(copyModeRejection(probe, makeConfig())).toBeNull();
        expect(quickTrimGateRejection(probe, makeConfig())).toBeNull();
    });
});
