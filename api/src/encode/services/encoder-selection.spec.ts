import { describe, expect, it } from 'vitest';
import {
    aacArgs,
    bitrateToVideoCrf,
    MEDIA_FOUNDATION_MAX_HEIGHT,
    bridgeVideoArgs,
    ENCODER_FOR,
    WINDOWS_CHAIN,
    decodeArgs,
    ladderVideoArgs,
    previewVideoArgs,
    nvencPreset,
    scalerExpr,
    x264Preset,
    type AccelMode,
} from './encoder-selection';

const MODES: AccelMode[] = [
    'nvidia',
    'intel',
    'amd',
    'mediafoundation',
    'apple',
    'cpu',
];

describe('x264Preset', () => {
    it('returns veryfast for 1080p and above', () => {
        expect(x264Preset(1080)).toBe('veryfast');
        expect(x264Preset(1440)).toBe('veryfast');
        expect(x264Preset(2160)).toBe('veryfast');
    });

    it('returns faster for 720p', () => {
        expect(x264Preset(720)).toBe('faster');
        expect(x264Preset(900)).toBe('faster');
    });

    it('returns fast for 480p', () => {
        expect(x264Preset(480)).toBe('fast');
        expect(x264Preset(576)).toBe('fast');
    });

    it('returns medium for 360p', () => {
        expect(x264Preset(360)).toBe('medium');
    });

    it('returns slow below 360p', () => {
        expect(x264Preset(240)).toBe('slow');
        expect(x264Preset(144)).toBe('slow');
    });
});

describe('nvencPreset', () => {
    it('returns p4 for 1080p and above', () => {
        expect(nvencPreset(1080)).toBe('p4');
        expect(nvencPreset(1440)).toBe('p4');
        expect(nvencPreset(2160)).toBe('p4');
    });

    it('returns p5 for 720p', () => {
        expect(nvencPreset(720)).toBe('p5');
    });

    it('returns p5 for 480p', () => {
        expect(nvencPreset(480)).toBe('p5');
    });

    it('returns p6 for 360p', () => {
        expect(nvencPreset(360)).toBe('p6');
    });

    it('returns p7 below 360p', () => {
        expect(nvencPreset(240)).toBe('p7');
        expect(nvencPreset(144)).toBe('p7');
    });
});

describe('bitrateToVideoCrf', () => {
    it('returns a CRF value for standard parameters', () => {
        const crf = bitrateToVideoCrf(2500, 1280, 720, 30);
        expect(crf).toBeGreaterThanOrEqual(16);
        expect(crf).toBeLessThanOrEqual(34);
    });

    it('clamps to a minimum of 16 for a high bitrate', () => {
        expect(bitrateToVideoCrf(50000, 640, 360, 30)).toBe(16);
    });

    it('clamps to a maximum of 34 for a very low bitrate', () => {
        expect(bitrateToVideoCrf(10, 3840, 2160, 30)).toBe(34);
    });

    it('treats a non-positive frame rate as 30', () => {
        const guarded = bitrateToVideoCrf(2500, 1280, 720, 0);
        expect(guarded).toBe(bitrateToVideoCrf(2500, 1280, 720, 30));
    });

    // A higher frame rate is fewer bits per pixel, so the quality target has to
    // relax. Getting this backwards is what made 50fps sources ride the rate cap.
    it('asks for a higher CRF as frame rate rises', () => {
        expect(bitrateToVideoCrf(2500, 1280, 720, 60)).toBeGreaterThan(
            bitrateToVideoCrf(2500, 1280, 720, 24)
        );
    });
});

describe('decodeArgs', () => {
    it('asks for no hardware decoder when nothing is re-encoded', () => {
        for (const mode of MODES) {
            expect(decodeArgs(mode, 'ladder', false)).toEqual([]);
        }
    });

    it('is empty on the CPU path', () => {
        expect(decodeArgs('cpu', 'ladder', true)).toEqual([]);
    });

    it('keeps CUDA frames on the device, with surfaces to spare', () => {
        expect(decodeArgs('nvidia', 'ladder', true)).toEqual([
            '-extra_hw_frames',
            '8',
            '-hwaccel',
            'cuda',
            '-hwaccel_output_format',
            'cuda',
        ]);
    });

    // Only the ladder splits one decode across many encoders, so only the ladder
    // drains NVDEC's surface pool. Asking for spares elsewhere would reserve
    // surfaces for a branch that never exists.
    it('reserves spare NVDEC surfaces for the ladder alone', () => {
        for (const purpose of ['preview', 'bridge'] as const) {
            expect(decodeArgs('nvidia', purpose, true)).toEqual([
                '-hwaccel',
                'cuda',
                '-hwaccel_output_format',
                'cuda',
            ]);
        }
    });

    it('selects videotoolbox and qsv output formats', () => {
        expect(decodeArgs('apple', 'ladder', true)).toEqual([
            '-hwaccel',
            'videotoolbox',
            '-hwaccel_output_format',
            'videotoolbox_vld',
        ]);
        expect(decodeArgs('intel', 'ladder', true)).toEqual([
            '-hwaccel',
            'qsv',
            '-hwaccel_output_format',
            'qsv',
        ]);
    });
});

describe('previewVideoArgs', () => {
    const encoderOf = (args: string[]) => args[args.indexOf('-c:v') + 1];

    it('selects the right encoder per mode', () => {
        expect(encoderOf(previewVideoArgs('nvidia', true))).toBe('h264_nvenc');
        expect(encoderOf(previewVideoArgs('intel', true))).toBe('h264_qsv');
        expect(encoderOf(previewVideoArgs('apple', true))).toBe(
            'h264_videotoolbox'
        );
        expect(encoderOf(previewVideoArgs('cpu', true))).toBe('libx264');
    });

    // The GPU flag is what the caller uses to force software, so a hardware mode
    // with useGpu false has to land on libx264 rather than half-configuring.
    it('falls back to libx264 when the GPU is not in use', () => {
        for (const mode of MODES) {
            expect(encoderOf(previewVideoArgs(mode, false))).toBe('libx264');
        }
    });

    it('emits no filter when there is nothing to scale', () => {
        for (const mode of MODES) {
            expect(previewVideoArgs(mode, true)).not.toContain('-vf');
        }
    });

    it('uses the scaler belonging to each mode', () => {
        const filterOf = (mode: AccelMode) => {
            const args = previewVideoArgs(mode, true, '640:360');
            return args[args.indexOf('-vf') + 1];
        };
        expect(filterOf('nvidia')).toBe('scale_cuda=640:360');
        expect(filterOf('intel')).toBe('vpp_qsv=w=640:h=360');
        expect(filterOf('cpu')).toBe('scale=640:360');
        // VideoToolbox takes the width and derives the height, which is fine for
        // a preview and would not be for a ladder rung bound to its playlist.
        expect(filterOf('apple')).toBe('scale_vt=w=640:h=-2');
    });
});

describe('bridgeVideoArgs', () => {
    const opts = { gopFrames: 48 };

    it('selects the right encoder per mode', () => {
        const encoderOf = (mode: AccelMode) => {
            const { head } = bridgeVideoArgs(mode, true, opts);
            return head[head.indexOf('-c:v') + 1];
        };
        expect(encoderOf('nvidia')).toBe('h264_nvenc');
        expect(encoderOf('intel')).toBe('h264_qsv');
        expect(encoderOf('apple')).toBe('h264_videotoolbox');
        expect(encoderOf('cpu')).toBe('libx264');
    });

    // Only the software path needs these, and they must follow the caller's own
    // rate and GOP flags — hence the split return rather than one array.
    it('pins pixel format and keyframe behaviour on the CPU path only', () => {
        const cpu = bridgeVideoArgs('cpu', true, opts);
        expect(cpu.head).toContain('-pix_fmt');
        expect(cpu.tail).toEqual(['-keyint_min', '48', '-sc_threshold', '0']);

        for (const mode of ['nvidia', 'intel', 'apple'] as AccelMode[]) {
            const hw = bridgeVideoArgs(mode, true, opts);
            expect(hw.head).not.toContain('-pix_fmt');
            expect(hw.tail).toEqual([]);
        }
    });

    it('honours an explicit pixel format', () => {
        const { head } = bridgeVideoArgs('cpu', true, {
            ...opts,
            pixFmt: 'yuv422p',
        });
        expect(head[head.indexOf('-pix_fmt') + 1]).toBe('yuv422p');
    });
});

describe('scalerExpr', () => {
    it('uses the device-side scaler for each mode', () => {
        expect(scalerExpr('nvidia', 1280, 720)).toBe('scale_cuda=1280:720');
        expect(scalerExpr('apple', 1280, 720)).toBe('scale_vt=w=1280:h=720');
        expect(scalerExpr('intel', 1280, 720)).toBe('vpp_qsv=w=1280:h=720');
        expect(scalerExpr('cpu', 1280, 720)).toBe('scale=1280:720');
    });
});

describe('ladderVideoArgs', () => {
    const r = { width: 1280, height: 720, videoBitrateKbps: 2500 };

    it('selects the right encoder per mode', () => {
        const encoderOf = (mode: AccelMode) => {
            const args = ladderVideoArgs(mode, r, 0, 30);
            return args[args.indexOf('-c:v:0') + 1];
        };
        expect(encoderOf('nvidia')).toBe('h264_nvenc');
        expect(encoderOf('intel')).toBe('h264_qsv');
        expect(encoderOf('apple')).toBe('h264_videotoolbox');
        expect(encoderOf('cpu')).toBe('libx264');
    });

    // One ffmpeg invocation writes the whole ladder, so an unsuffixed flag would
    // apply to every rendition at once.
    it('suffixes every flag with the output index', () => {
        for (const mode of MODES) {
            const args = ladderVideoArgs(mode, r, 3, 30);
            const flags = args.filter((a) => a.startsWith('-'));
            expect(flags.length).toBeGreaterThan(0);
            for (const flag of flags) {
                expect(flag).toMatch(/:v:3$/);
            }
        }
    });

    it('uses quality-targeted rate control only when vbr is set', () => {
        expect(ladderVideoArgs('nvidia', { ...r, vbr: true }, 0, 30)).toContain(
            '-cq:v:0'
        );
        expect(
            ladderVideoArgs('nvidia', { ...r, vbr: false }, 0, 30)
        ).not.toContain('-cq:v:0');

        expect(ladderVideoArgs('intel', { ...r, vbr: true }, 0, 30)).toContain(
            '-global_quality:v:0'
        );
        expect(ladderVideoArgs('cpu', { ...r, vbr: true }, 0, 30)).toContain(
            '-crf:v:0'
        );
    });

    // x264 cuts a keyframe at every scene change, which lands off the GOP cadence
    // and shortens the HLS segment that follows. The hardware encoders do not.
    it('disables scene-cut detection on the CPU path only', () => {
        expect(ladderVideoArgs('cpu', r, 0, 30)).toContain('-sc_threshold:v:0');
        for (const mode of ['nvidia', 'intel', 'apple'] as AccelMode[]) {
            expect(ladderVideoArgs(mode, r, 0, 30)).not.toContain(
                '-sc_threshold:v:0'
            );
        }
    });

    it('allows the software fallback inside videotoolbox', () => {
        expect(ladderVideoArgs('apple', r, 0, 30)).toContain('-allow_sw:v:0');
    });
});

describe('aacArgs', () => {
    it('states the LC profile rather than relying on the default', () => {
        expect(aacArgs()).toEqual(['-c:a', 'aac', '-profile:a', 'aac_low']);
    });

    // The ladder writes several outputs from one invocation, so an unsuffixed
    // flag would apply to all of them.
    it('carries the output index when given one', () => {
        expect(aacArgs(2)).toEqual([
            '-c:a:2',
            'aac',
            '-profile:a:2',
            'aac_low',
        ]);
    });

    // HE-AAC and HE-AACv2 carry patents running years past AAC-LC's, and
    // fdk-aac cannot be distributed at all. None may appear here.
    it('names no profile other than LC', () => {
        for (const args of [aacArgs(), aacArgs(0)]) {
            expect(args.join(' ')).not.toMatch(/aac_he|libfdk/i);
        }
    });
});

describe('the Windows fallback chain', () => {
    it('is ordered best-first and ends at the encoder every install has', () => {
        expect(WINDOWS_CHAIN).toEqual([
            'nvidia',
            'intel',
            'amd',
            'mediafoundation',
        ]);
    });

    // The failure this guards against is silent: a mode with no case of its own
    // falls to the switch default, which is libx264. An AMD machine would then
    // encode in software while reporting that it was using AMF — and after
    // libx264 goes, it would simply fail.
    it('gives every mode an encoder of its own, never the software default', () => {
        for (const mode of MODES) {
            const ladder = ladderVideoArgs(
                mode,
                { width: 1280, height: 720, videoBitrateKbps: 2500 },
                0,
                30
            );
            const preview = previewVideoArgs(mode, true);
            const bridge = bridgeVideoArgs(mode, true, { gopFrames: 48 });

            const expected = ENCODER_FOR[mode];
            expect(ladder[ladder.indexOf('-c:v:0') + 1]).toBe(expected);
            expect(preview[preview.indexOf('-c:v') + 1]).toBe(expected);
            expect(bridge.head[bridge.head.indexOf('-c:v') + 1]).toBe(expected);

            if (mode !== 'cpu') {
                expect(ladder).not.toContain('libx264');
                expect(preview).not.toContain('libx264');
                expect(bridge.head).not.toContain('libx264');
            }
        }
    });

    // Both take software frames, so no hardware decode or device-side scaler.
    // Asking for one would build a filter graph ffmpeg refuses to assemble.
    it('keeps the new encoders on software frames', () => {
        for (const mode of ['amd', 'mediafoundation'] as AccelMode[]) {
            expect(decodeArgs(mode, 'ladder', true)).toEqual([]);
            expect(scalerExpr(mode, 640, 360)).toBe('scale=640:360');
        }
    });

    // h264_mf's rate control is thin and AMF has not been run here. Emitting a
    // quality-targeted option an encoder rejects is a failure to open, not a
    // worse picture — so neither gets one until someone has measured them.
    it('asks neither new encoder for a quality target', () => {
        const r = {
            width: 1280,
            height: 720,
            videoBitrateKbps: 2500,
            vbr: true,
        };
        for (const mode of ['amd', 'mediafoundation'] as AccelMode[]) {
            const args = ladderVideoArgs(mode, r, 0, 30);
            expect(args).not.toContain('-cq:v:0');
            expect(args).not.toContain('-crf:v:0');
            expect(args).not.toContain('-global_quality:v:0');
            expect(args).toContain('-b:v:0');
        }
    });
});

describe('what a user is told when encoding is not possible', () => {
    const r = { width: 1280, height: 720, videoBitrateKbps: 2500 };

    // A message that names no way out is a dead end: the substitution path
    // exists, so the failure has to mention it. Agreed with the product owner.
    it('names the way out when there is no encoder at all', () => {
        let message = '';
        try {
            ladderVideoArgs('none', r, 0, 30);
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/no encoder this app can use/i);
        expect(message).toMatch(/Choose FFmpeg/);
        expect(message).toMatch(/FFMPEG_PATH/);
    });

    // Media Foundation's ceiling is accepted rather than worked around, so the
    // message has to name the rendition that will not work and what to do.
    it('names the rendition Media Foundation cannot encode', () => {
        let message = '';
        try {
            ladderVideoArgs(
                'mediafoundation',
                { width: 3840, height: 2160, videoBitrateKbps: 12000 },
                0,
                30
            );
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain('2160p');
        expect(message).toMatch(/cannot encode above/i);
        expect(message).toMatch(/Choose FFmpeg/);
    });

    it('allows Media Foundation up to its ceiling', () => {
        expect(() =>
            ladderVideoArgs(
                'mediafoundation',
                {
                    width: 1920,
                    height: MEDIA_FOUNDATION_MAX_HEIGHT,
                    videoBitrateKbps: 6000,
                },
                0,
                30
            )
        ).not.toThrow();
    });

    // The ceiling belongs to that encoder alone. A GPU machine must not be
    // refused a 4K rendition because of a limit that does not apply to it.
    it('does not apply the ceiling to any other encoder', () => {
        for (const mode of ['nvidia', 'intel', 'amd', 'apple'] as AccelMode[]) {
            expect(() =>
                ladderVideoArgs(
                    mode,
                    { width: 3840, height: 2160, videoBitrateKbps: 12000 },
                    0,
                    30
                )
            ).not.toThrow();
        }
    });
});
