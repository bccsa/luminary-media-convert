import { ThumbnailService, formatVttTime } from './thumbnail.service.js';

describe('formatVttTime', () => {
    it('should format zero', () => {
        expect(formatVttTime(0)).toBe('00:00:00.000');
    });

    it('should format fractional seconds', () => {
        expect(formatVttTime(1.5)).toBe('00:00:01.500');
    });

    it('should format minutes and seconds', () => {
        expect(formatVttTime(65)).toBe('00:01:05.000');
    });

    it('should format hours', () => {
        expect(formatVttTime(3661.25)).toBe('01:01:01.250');
    });

    it('should handle large values', () => {
        expect(formatVttTime(36000)).toBe('10:00:00.000');
    });
});

describe('ThumbnailService', () => {
    let service: ThumbnailService;

    beforeEach(() => {
        service = new ThumbnailService();
    });

    describe('buildVtt', () => {
        it('should generate correct VTT for a short video', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(15, spriteFiles, 160, 90);

            expect(vtt).toContain('WEBVTT');
            expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
            expect(vtt).toContain('sprite_001.webp#xywh=0,0,160,90');
            expect(vtt).toContain('00:00:05.000 --> 00:00:10.000');
            expect(vtt).toContain('sprite_001.webp#xywh=160,0,160,90');
            expect(vtt).toContain('00:00:10.000 --> 00:00:15.000');
            expect(vtt).toContain('sprite_001.webp#xywh=320,0,160,90');
        });

        it('should wrap to next row after COLUMNS thumbnails', () => {
            const spriteFiles = ['sprite_001.webp'];
            // 30s = 6 thumbnails at 5s interval
            const vtt = service.buildVtt(30, spriteFiles, 160, 90);

            // 6th thumbnail (index 5) should be at row 1
            expect(vtt).toContain('00:00:25.000 --> 00:00:30.000');
            expect(vtt).toContain('sprite_001.webp#xywh=0,90,160,90');
        });

        it('should use second sprite sheet after 25 thumbnails', () => {
            const spriteFiles = ['sprite_001.webp', 'sprite_002.webp'];
            // 130s = 26 thumbnails, so #26 goes to sprite_002
            const vtt = service.buildVtt(130, spriteFiles, 160, 90);

            expect(vtt).toContain('00:02:05.000 --> 00:02:10.000');
            expect(vtt).toContain('sprite_002.webp#xywh=0,0,160,90');
        });

        it('should clamp last cue end time to duration', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(7, spriteFiles, 160, 90);

            expect(vtt).toContain('00:00:05.000 --> 00:00:07.000');
        });

        it('should handle exact multiples of interval', () => {
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(10, spriteFiles, 160, 90);

            const lines = vtt.split('\n');
            const timeLines = lines.filter((l) => l.includes(' --> '));
            expect(timeLines).toHaveLength(2);
        });

        it('should calculate correct sprite sheet count for long videos', () => {
            // 600s = 120 thumbnails = 5 sprite sheets (25 per sheet)
            const spriteFiles = [
                'sprite_001.webp',
                'sprite_002.webp',
                'sprite_003.webp',
                'sprite_004.webp',
                'sprite_005.webp',
            ];
            const vtt = service.buildVtt(600, spriteFiles, 160, 90);

            // Last thumbnail should reference sprite_005
            expect(vtt).toContain('sprite_005.webp');
        });

        it('should stop when sprite files run out', () => {
            // 130s = 26 thumbnails but only 1 sprite (25 thumbs)
            const spriteFiles = ['sprite_001.webp'];
            const vtt = service.buildVtt(130, spriteFiles, 160, 90);

            const timeLines = vtt.split('\n').filter((l) => l.includes(' --> '));
            expect(timeLines).toHaveLength(25);
        });
    });

    describe('generateThumbnails', () => {
        it('should return null when duration is 0', async () => {
            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: 0,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            expect(result).toBeNull();
        });

        it('should return null when duration is negative', async () => {
            const result = await service.generateThumbnails({
                inputPath: '/tmp/test.mp4',
                outputDir: '/tmp/output',
                duration: -1,
                sourceWidth: 1920,
                sourceHeight: 1080,
            });
            expect(result).toBeNull();
        });
    });
});
