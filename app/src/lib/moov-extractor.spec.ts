import { describe, it, expect } from 'vitest';
import { extractMoov, extractFileHeader } from './moov-extractor';

/** Build a minimal MP4-like File from top-level boxes */
function buildMp4File(boxes: Array<{ type: string; size: number }>): File {
    let totalSize = 0;
    for (const b of boxes) totalSize += b.size;

    const buf = new Uint8Array(totalSize);
    let offset = 0;
    for (const b of boxes) {
        // Write 32-bit size (big endian)
        buf[offset] = (b.size >>> 24) & 0xff;
        buf[offset + 1] = (b.size >>> 16) & 0xff;
        buf[offset + 2] = (b.size >>> 8) & 0xff;
        buf[offset + 3] = b.size & 0xff;
        // Write 4-char type
        for (let i = 0; i < 4; i++) {
            buf[offset + 4 + i] = b.type.charCodeAt(i);
        }
        offset += b.size;
    }

    return new File([buf], 'test.mp4', { type: 'video/mp4' });
}

describe('moov-extractor', () => {
    describe('extractMoov', () => {
        it('should return null for files smaller than 8 bytes', async () => {
            const file = new File([new Uint8Array(4)], 'tiny.mp4');
            expect(await extractMoov(file)).toBeNull();
        });

        it('should return null for non-MP4 files (no ftyp)', async () => {
            // MKV starts with EBML header, not ftyp
            const file = new File([new Uint8Array(1024)], 'test.mkv');
            expect(await extractMoov(file)).toBeNull();
        });

        it('should return null for faststart MP4 (moov before mdat)', async () => {
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'moov', size: 100 },
                { type: 'mdat', size: 1000 },
            ]);
            expect(await extractMoov(file)).toBeNull();
        });

        it('should return ftyp + moov for moov-at-end MP4', async () => {
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'mdat', size: 500 },
                { type: 'moov', size: 100 },
            ]);
            const result = await extractMoov(file);
            expect(result).not.toBeNull();
            expect(result!.ftypSize).toBe(32);
            expect(result!.ftyp.byteLength).toBe(32);
            expect(result!.moov.byteLength).toBe(100);
        });

        it('should return null when moov box is not found', async () => {
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'mdat', size: 500 },
            ]);
            expect(await extractMoov(file)).toBeNull();
        });
    });

    describe('extractFileHeader', () => {
        it('should return null for small files', async () => {
            const file = new File([new Uint8Array(1000)], 'small.mkv');
            expect(await extractFileHeader(file)).toBeNull();
        });

        it('should return null for moov-at-end MP4', async () => {
            // Build a large enough moov-at-end MP4
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'mdat', size: 5 * 1024 * 1024 },
                { type: 'moov', size: 100 },
            ]);
            expect(await extractFileHeader(file)).toBeNull();
        });

        it('should return complete ftyp+moov for faststart MP4', async () => {
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'moov', size: 500 },
                { type: 'mdat', size: 5 * 1024 * 1024 },
            ]);
            const result = await extractFileHeader(file);
            expect(result).not.toBeNull();
            // Should include complete ftyp (32) + moov (500) = 532 bytes
            expect(result!.byteLength).toBe(532);
        });

        it('should return first 2 MB for non-MP4 files (MKV)', async () => {
            // Create a large non-MP4 file (no ftyp box)
            const size = 5 * 1024 * 1024;
            const file = new File([new Uint8Array(size)], 'test.mkv');
            const result = await extractFileHeader(file);
            expect(result).not.toBeNull();
            expect(result!.byteLength).toBe(2 * 1024 * 1024);
        });

        it('should return null for MP4 without moov box found', async () => {
            // ftyp present but no moov found — skip
            const file = buildMp4File([
                { type: 'ftyp', size: 32 },
                { type: 'mdat', size: 5 * 1024 * 1024 },
            ]);
            expect(await extractFileHeader(file)).toBeNull();
        });
    });
});
