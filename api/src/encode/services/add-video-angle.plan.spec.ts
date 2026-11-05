import { describe, expect, it } from 'vitest';
import {
    angleCodecs,
    angleRenditionDir,
    buildAddAngleArgs,
    estimateVideoBitrateKbps,
    type VideoAnglePlan,
} from './add-video-angle.plan.js';

const plan = (over: Partial<VideoAnglePlan> = {}): VideoAnglePlan => ({
    inputPath: '/media/pulpit.mov',
    sourceTrackIndex: 1,
    offsetSec: 0,
    durationSec: 3600,
    segmentDurationSec: 6,
    frameRate: 29.97,
    accelMode: 'cpu',
    renditions: [
        {
            dir: 'stream_addab_0_Pulpit_1080p',
            width: 1920,
            height: 1080,
            videoBitrateKbps: 5000,
            referenceUri: 'stream_0_1920x1080/playlist.m3u8',
        },
        {
            dir: 'stream_addab_1_Pulpit_720p',
            width: 1280,
            height: 720,
            videoBitrateKbps: 2500,
            referenceUri: 'stream_1_1280x720/playlist.m3u8',
        },
    ],
    outputDir: '/work/s/add-angle-ab',
    masterName: 'angle-master.m3u8',
    ...over,
});

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildAddAngleArgs', () => {
    it("encodes the chosen picture to every size, on the video's frame rate and length", () => {
        const args = buildAddAngleArgs(plan());
        const filter = after(args, '-filter_complex');
        expect(filter).toContain(
            '[0:v:1]fps=29.97,tpad=stop_mode=add:stop_duration=3600:color=black,trim=end=3600,setpts=PTS-STARTPTS,split=2[s0][s1]'
        );
        // Fitted inside each size on black, never stretched.
        expect(filter).toContain(
            '[s1]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v1]'
        );
        expect(args).toContain('-an');
        expect(after(args, '-var_stream_map')).toBe(
            'v:0,name:stream_addab_0_Pulpit_1080p v:1,name:stream_addab_1_Pulpit_720p'
        );
        expect(after(args, '-master_pl_name')).toBe('angle-master.m3u8');
    });

    it('puts a keyframe on every segment boundary of every rendition', () => {
        const args = buildAddAngleArgs(plan());
        for (const i of [0, 1]) {
            expect(after(args, `-g:v:${i}`)).toBe('180');
            expect(after(args, `-keyint_min:v:${i}`)).toBe('180');
            expect(after(args, `-force_key_frames:v:${i}`)).toBe(
                'expr:gte(t,n_forced*6)'
            );
        }
        expect(after(args, '-hls_time')).toBe('6');
    });

    it('shows black before a late start, and skips the head of an early one', () => {
        const late = buildAddAngleArgs(plan({ offsetSec: 2.5 }));
        expect(after(late, '-filter_complex')).toContain(
            'tpad=start_duration=2.5:stop_mode=add'
        );
        expect(late).not.toContain('-ss');

        const early = buildAddAngleArgs(plan({ offsetSec: -12 }));
        expect(early.indexOf('-ss')).toBeLessThan(early.indexOf('-i'));
        expect(after(early, '-ss')).toBe('12');
        expect(after(early, '-filter_complex')).not.toContain('start_duration');
    });

    it('hands a hardware encoder frames it takes from memory', () => {
        const args = buildAddAngleArgs(plan({ accelMode: 'apple' }));
        expect(after(args, '-filter_complex')).toContain('format=nv12[v0]');
        expect(after(args, '-c:v:0')).toBe('h264_videotoolbox');
        expect(args).not.toContain('-hwaccel');
    });
});

describe('angleRenditionDir', () => {
    it('names a folder no encode writes', () => {
        expect(angleRenditionDir('ab12cd', 0, 'Côté chaire', 1080)).toBe(
            'stream_addab12cd_0_C_t_chaire_1080p'
        );
        expect(angleRenditionDir('ab12cd', 1, '***', 720)).toBe(
            'stream_addab12cd_1_720p'
        );
    });
});

describe('estimateVideoBitrateKbps', () => {
    it('rounds the measured rate to 50 kbps, with a floor', () => {
        expect(estimateVideoBitrateKbps((3_000_000 * 60) / 8, 60)).toBe(3000);
        expect(estimateVideoBitrateKbps((2_437_000 * 10) / 8, 10)).toBe(2450);
        expect(estimateVideoBitrateKbps(100, 60)).toBe(100);
        expect(estimateVideoBitrateKbps(0, 60)).toBe(2000);
    });
});

describe('angleCodecs', () => {
    it("joins the new picture's codec to the existing variant's audio", () => {
        expect(angleCodecs('avc1.64001f', 'avc1.640028,mp4a.40.2')).toBe(
            'avc1.64001f,mp4a.40.2'
        );
        expect(angleCodecs('avc1.64001f')).toBe('avc1.64001f');
    });
});
