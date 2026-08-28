import { describe, expect, it } from 'vitest';
import {
    bitrateToVideoCrf,
    decodeArgs,
    ladderVideoArgs,
    nvencPreset,
    scalerExpr,
    x264Preset,
    type AccelMode,
} from './encoder-selection';

const MODES: AccelMode[] = ['nvidia', 'intel', 'apple', 'cpu'];

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
            expect(decodeArgs(mode, false)).toEqual([]);
        }
    });

    it('is empty on the CPU path', () => {
        expect(decodeArgs('cpu', true)).toEqual([]);
    });

    it('keeps CUDA frames on the device, with surfaces to spare', () => {
        expect(decodeArgs('nvidia', true)).toEqual([
            '-extra_hw_frames',
            '8',
            '-hwaccel',
            'cuda',
            '-hwaccel_output_format',
            'cuda',
        ]);
    });

    it('selects videotoolbox and qsv output formats', () => {
        expect(decodeArgs('apple', true)).toEqual([
            '-hwaccel',
            'videotoolbox',
            '-hwaccel_output_format',
            'videotoolbox_vld',
        ]);
        expect(decodeArgs('intel', true)).toEqual([
            '-hwaccel',
            'qsv',
            '-hwaccel_output_format',
            'qsv',
        ]);
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
