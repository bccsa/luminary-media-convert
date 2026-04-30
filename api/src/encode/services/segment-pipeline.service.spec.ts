import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Logger } from '@nestjs/common';
import { SegmentPipeline, type SegmentPipelineConfig } from './segment-pipeline.service.js';

function makePipeline(outputDir: string, overrides?: Partial<SegmentPipelineConfig>): SegmentPipeline {
    const mockS3Service = {
        createClient: vi.fn().mockReturnValue({}),
        uploadFile: vi.fn().mockResolvedValue(undefined),
    };

    const config: SegmentPipelineConfig = {
        outputDir,
        s3Config: { endPoint: 'localhost', port: 9000, useSSL: false, accessKey: 'x', secretKey: 'x', bucket: 'b' } as any,
        s3PathPrefix: 'prefix',
        byteRange: false,
        byteRangeMaxFileSizeBytes: 500 * 1024 * 1024,
        ...overrides,
    };

    return new SegmentPipeline(
        config,
        {} as any,
        mockS3Service as any,
        new Logger('Test'),
    );
}

describe('SegmentPipeline', () => {
    describe('uploadRemainingFiles', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('should skip concat.txt from uploads', async () => {
            // Create files including concat.txt
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            writeFileSync(join(tmpDir, 'concat.txt'), 'ffconcat version 1.0\n');
            mkdirSync(join(tmpDir, 'stream_0'));
            writeFileSync(join(tmpDir, 'stream_0', 'playlist.m3u8'), '#EXTM3U\n');

            const pipeline = makePipeline(tmpDir);
            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toContain('prefix/master.m3u8');
            expect(keys).toContain('prefix/stream_0/playlist.m3u8');
            expect(keys).not.toContain('prefix/concat.txt');
        });

        it('should upload all files when no concat.txt present', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            mkdirSync(join(tmpDir, 'thumbnails'));
            writeFileSync(join(tmpDir, 'thumbnails', 'thumbnails.vtt'), 'WEBVTT\n');

            const pipeline = makePipeline(tmpDir);
            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toContain('prefix/master.m3u8');
            expect(keys).toContain('prefix/thumbnails/thumbnails.vtt');
        });

        it('should respect exclude set', async () => {
            const excludedPath = join(tmpDir, 'master.m3u8');
            writeFileSync(excludedPath, '#EXTM3U\n');
            writeFileSync(join(tmpDir, 'other.m3u8'), '#EXTM3U\n');

            const pipeline = makePipeline(tmpDir);
            const keys = await pipeline.uploadRemainingFiles(tmpDir, new Set([excludedPath]));

            expect(keys).not.toContain('prefix/master.m3u8');
            expect(keys).toContain('prefix/other.m3u8');
        });
    });
});
