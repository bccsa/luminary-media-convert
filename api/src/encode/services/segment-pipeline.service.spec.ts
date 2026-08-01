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

    /**
     * The watchdog exists to catch an upload that has genuinely stopped. It has
     * to tell that apart from one that is merely slow, and completed-file counts
     * cannot: byte-range packing writes files of a few hundred MB, and one of
     * those on a slow link takes longer than the timeout while transferring
     * perfectly well. A 500 MB pack at 2 MB/s takes over four minutes; a
     * five-minute completion-based detector discarded a finished hour-long
     * encode twice, with every upload succeeding.
     */
    describe('drain stall detection', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-stall-'));
            process.env.S3_UPLOAD_STALL_TIMEOUT_MS = '250';
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
            delete process.env.S3_UPLOAD_STALL_TIMEOUT_MS;
        });

        /** A single upload that trickles bytes for longer than the timeout. */
        function pipelineWithSlowUpload(totalMs: number, onBytes = true) {
            const pipeline = makePipeline(tmpDir);
            const s3 = (pipeline as any).s3Service;
            s3.uploadFile = vi.fn(
                async (
                    _c: unknown,
                    _b: string,
                    _f: string,
                    _k: string,
                    report?: (n: number) => void
                ) => {
                    const step = 50;
                    for (let t = 0; t < totalMs; t += step) {
                        await new Promise((r) => setTimeout(r, step));
                        if (onBytes && report) report(1024);
                    }
                }
            );
            return pipeline;
        }

        it('does not trip while bytes are still moving', async () => {
            // Four times the stall window, but never silent for one.
            const pipeline = pipelineWithSlowUpload(1000);
            writeFileSync(join(tmpDir, 'big.m4s'), 'x');

            (pipeline as any).enqueueUpload({
                filePath: join(tmpDir, 'big.m4s'),
                objectKey: 'prefix/big.m4s',
            });

            await expect(
                (pipeline as any).waitForUploads()
            ).resolves.toBeUndefined();
        });

        it('still trips when nothing moves at all', async () => {
            // The case it exists for: bytes stop, and stay stopped.
            const pipeline = pipelineWithSlowUpload(1000, false);
            writeFileSync(join(tmpDir, 'stuck.m4s'), 'x');

            (pipeline as any).enqueueUpload({
                filePath: join(tmpDir, 'stuck.m4s'),
                objectKey: 'prefix/stuck.m4s',
            });

            await expect((pipeline as any).waitForUploads()).rejects.toThrow(
                /no bytes sent to S3/
            );
        });

        it('reports how much it did send', async () => {
            // "uploaded=1401" counted segments while the transfers were a few
            // large files, which read as though uploads had succeeded and
            // vanished. The message should say what actually left.
            const pipeline = pipelineWithSlowUpload(1000, false);
            writeFileSync(join(tmpDir, 'stuck.m4s'), 'x');

            (pipeline as any).enqueueUpload({
                filePath: join(tmpDir, 'stuck.m4s'),
                objectKey: 'prefix/stuck.m4s',
            });

            await expect((pipeline as any).waitForUploads()).rejects.toThrow(
                /sent=\d+MB/
            );
        });
    });
});
