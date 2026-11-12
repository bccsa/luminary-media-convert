import { describe, expect, it } from 'vitest';
import { FfmpegOutput } from './ffmpeg-output';

const progress = (frame: number) =>
    [
        `frame=${frame}`,
        'fps=546.00',
        'stream_0_0_q=-0.0',
        'bitrate=N/A',
        'total_size=N/A',
        `out_time_us=${frame * 40000}`,
        `out_time=00:00:${String(frame % 60).padStart(2, '0')}.000000`,
        'speed=21.5x',
        'progress=continue',
    ].join('\n') + '\n';

describe('FfmpegOutput', () => {
    it('keeps the start of the output, where a device that will not open says so', () => {
        const out = new FfmpegOutput();
        out.push(
            '[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: unsupported device (2): (no details)\n'
        );
        for (let i = 0; i < 5000; i++) out.push(progress(i));
        out.push('Conversion failed!\n');

        const report = out.report();
        expect(report).toContain(
            'OpenEncodeSessionEx failed: unsupported device'
        );
        expect(report).toContain('Conversion failed!');
    });

    it('leaves out progress, the stats line and segment opening, which say nothing about a failure', () => {
        const out = new FfmpegOutput();
        out.push(progress(1));
        out.push(
            'frame=18659 fps=546 q=-0.0 size=N/A time=00:12:14.40 bitrate=N/A speed=21.5x elapsed=0:00:34.17    \r'
        );
        out.push(
            "[hls @ 0x7b4d090780] Opening '/work/s/output/stream_144p/segment_00122.m4s' for writing\n"
        );
        out.push('Error while filtering: Cannot allocate memory\n');

        expect(out.report()).toBe(
            'Error while filtering: Cannot allocate memory'
        );
    });

    it('takes lines split across chunks whole', () => {
        const out = new FfmpegOutput();
        out.push('[vist#0:0/h264 @ 0x2] Error during demuxing: ');
        out.push('Invalid data found when processing input\n');
        expect(out.report()).toBe(
            '[vist#0:0/h264 @ 0x2] Error during demuxing: Invalid data found when processing input'
        );
    });

    it('keeps the last line even when it has no line break yet', () => {
        const out = new FfmpegOutput();
        out.push('Conversion failed!');
        expect(out.report()).toBe('Conversion failed!');
    });

    it('says how much it left out of a long middle, and stays bounded', () => {
        const out = new FfmpegOutput({ headBytes: 100, tailBytes: 100 });
        for (let i = 0; i < 1000; i++) out.push(`[aac @ 0x3] line ${i}\n`);

        const report = out.report();
        expect(report).toContain('[aac @ 0x3] line 0');
        expect(report).toContain('[aac @ 0x3] line 999');
        expect(report).toMatch(/… \d+ lines left out …/);
        expect(report.length).toBeLessThan(400);
    });

    it('is empty when ffmpeg said nothing but progress', () => {
        const out = new FfmpegOutput();
        out.push(progress(1));
        expect(out.report()).toBe('');
    });
});
