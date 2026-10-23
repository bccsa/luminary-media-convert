import { describe, it, expect } from 'vitest';
import {
    buildAddAudioArgs,
    estimateBitrateKbps,
    renditionDir,
} from './add-audio-track.plan.js';

const plan = {
    inputPath: '/media/fr.wav',
    sourceTrackIndex: 1,
    offsetSec: 0,
    durationSec: 3600.5,
    segmentDurationSec: 6,
    outputDir: '/work/add',
    renditions: [
        {
            groupId: 'aud_hd',
            dir: 'stream_addab12_0_Fr',
            bitrateKbps: 128,
            channels: 2,
            sampleRate: 48000,
        },
        {
            groupId: 'aud_low',
            dir: 'stream_addab12_1_Fr',
            bitrateKbps: 64,
            channels: 1,
            sampleRate: 44100,
        },
    ],
};
const valueAfter = (args: string[], flag: string) =>
    args[args.indexOf(flag) + 1];

describe('buildAddAudioArgs', () => {
    it('encodes one rendition per audio group, each as that group is', () => {
        const args = buildAddAudioArgs(plan);
        expect(valueAfter(args, '-b:a:0')).toBe('128k');
        expect(valueAfter(args, '-ac:a:0')).toBe('2');
        expect(valueAfter(args, '-ar:a:0')).toBe('48000');
        expect(valueAfter(args, '-b:a:1')).toBe('64k');
        expect(valueAfter(args, '-ac:a:1')).toBe('1');
        expect(valueAfter(args, '-ar:a:1')).toBe('44100');
        expect(valueAfter(args, '-var_stream_map')).toBe(
            'a:0,name:stream_addab12_0_Fr a:1,name:stream_addab12_1_Fr'
        );
    });

    it("muxes as the encoder's own audio does: AAC-LC in fMP4 segments of the video's length", () => {
        const args = buildAddAudioArgs(plan);
        expect(valueAfter(args, '-c:a:0')).toBe('aac');
        expect(valueAfter(args, '-profile:a:0')).toBe('aac_low');
        expect(valueAfter(args, '-hls_segment_type')).toBe('fmp4');
        expect(valueAfter(args, '-hls_time')).toBe('6');
        expect(valueAfter(args, '-hls_fmp4_init_filename')).toBe('init.mp4');
    });

    it("takes the file's chosen audio stream and lasts exactly as long as the video", () => {
        const filter = valueAfter(buildAddAudioArgs(plan), '-filter_complex');
        expect(filter.startsWith('[0:a:1]')).toBe(true);
        expect(filter).toContain('apad,atrim=end=3600.5');
        expect(filter).toContain('asplit=2[s0][s1]');
        expect(filter).not.toContain('adelay');
    });

    it('adds silence before a file that starts later than the video', () => {
        const args = buildAddAudioArgs({ ...plan, offsetSec: 2.5 });
        expect(valueAfter(args, '-filter_complex')).toContain(
            'adelay=delays=2500:all=1'
        );
        expect(args).not.toContain('-ss');
    });

    it('drops the first seconds of a file that starts earlier than the video', () => {
        const args = buildAddAudioArgs({ ...plan, offsetSec: -4 });
        expect(valueAfter(args, '-ss')).toBe('4');
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
        expect(valueAfter(args, '-filter_complex')).not.toContain('adelay');
    });
});

describe('estimateBitrateKbps', () => {
    it("rounds to the nearest of the encoder's bitrates", () => {
        // 128 kbps for an hour, with a little container overhead.
        expect(estimateBitrateKbps((131_000 * 3600) / 8, 3600)).toBe(128);
        expect(estimateBitrateKbps((66_000 * 60) / 8, 60)).toBe(64);
    });

    it('falls back to 128 when there is nothing to measure', () => {
        expect(estimateBitrateKbps(0, 60)).toBe(128);
        expect(estimateBitrateKbps(1000, 0)).toBe(128);
    });
});

describe('renditionDir', () => {
    it("is named apart from the encoder's own stream_<n> folders, and keeps a readable label", () => {
        expect(renditionDir('ab12', 0, 'Français (dub)')).toBe(
            'stream_addab12_0_Fran_ais_dub'
        );
        expect(renditionDir('ab12', 1, '"')).toBe('stream_addab12_1');
    });
});
