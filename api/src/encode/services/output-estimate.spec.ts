import { estimateOutputBytes, formatBytes } from './output-estimate.js';

const ladder = {
    videoRenditions: [
        { videoBitrateKbps: 5000 },
        { videoBitrateKbps: 2500 },
        { videoBitrateKbps: 1000 },
        { videoBitrateKbps: 600 },
        { videoBitrateKbps: 300 },
        { videoBitrateKbps: 150 },
    ],
    audioGroups: [
        { audioBitrateKbps: 128 },
        { audioBitrateKbps: 128 },
        { audioBitrateKbps: 128 },
    ],
} as any;

describe('estimateOutputBytes', () => {
    it('sums every rendition and audio group', () => {
        // 1000 kbps for 8s = 1 MB exactly, before overhead.
        const bytes = estimateOutputBytes(
            { videoRenditions: [{ videoBitrateKbps: 600 }] as any, audioGroups: [{ audioBitrateKbps: 400 }] as any },
            8
        );

        expect(bytes).toBe(Math.round(1_000_000 * 1.2));
    });

    it('scales with duration', () => {
        const short = estimateOutputBytes(ladder, 60);
        const long = estimateOutputBytes(ladder, 600);

        expect(long).toBe(short * 10);
    });

    it('over-estimates rather than under', () => {
        // Refusing an encode that would just have fit costs a re-run; accepting
        // one that does not costs the whole job.
        const raw = ((10_734 * 1000) / 8) * 100;
        const bytes = estimateOutputBytes(ladder, 100);

        expect(bytes).toBeGreaterThan(raw);
    });

    it('puts a real hour-long ladder in the right order of magnitude', () => {
        // The staging case: six renditions plus five audio tracks over 5018s
        // produced output in the several-GB range.
        const bytes = estimateOutputBytes(ladder, 5018);

        expect(bytes).toBeGreaterThan(5 * 1024 ** 3);
        expect(bytes).toBeLessThan(12 * 1024 ** 3);
    });

    it('returns 0 when the duration is unknown', () => {
        // Callers treat 0 as "cannot judge" and proceed, rather than refusing.
        expect(estimateOutputBytes(ladder, 0)).toBe(0);
        expect(estimateOutputBytes(ladder, -1)).toBe(0);
    });

    it('returns 0 when nothing declares a bitrate', () => {
        expect(estimateOutputBytes({}, 600)).toBe(0);
        expect(
            estimateOutputBytes({ videoRenditions: [], audioGroups: [] } as any, 600)
        ).toBe(0);
    });

    it('ignores renditions with no bitrate rather than failing', () => {
        const bytes = estimateOutputBytes(
            { videoRenditions: [{}, { videoBitrateKbps: 800 }] as any },
            10
        );

        expect(bytes).toBe(Math.round(((800 * 1000) / 8) * 10 * 1.2));
    });
});

describe('formatBytes', () => {
    it('reads as GB once it is worth reading that way', () => {
        expect(formatBytes(7 * 1024 ** 3)).toBe('7.0 GB');
        expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    });

    it('reads as MB below a GB', () => {
        expect(formatBytes(500 * 1024 ** 2)).toBe('500 MB');
    });

    it('falls back to bytes for small values', () => {
        expect(formatBytes(512)).toBe('512 bytes');
    });
});
