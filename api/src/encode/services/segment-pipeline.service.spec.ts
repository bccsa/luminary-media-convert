import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Logger } from '@nestjs/common';
import {
    SegmentPipeline,
    type SegmentPipelineConfig,
} from './segment-pipeline.service.js';

function makePipeline(
    outputDir: string,
    overrides?: Partial<SegmentPipelineConfig>
): SegmentPipeline {
    const mockS3Service = {
        createClient: vi.fn().mockReturnValue({}),
        uploadFile: vi.fn().mockResolvedValue(undefined),
    };

    const config: SegmentPipelineConfig = {
        outputDir,
        s3Config: {
            endPoint: 'localhost',
            port: 9000,
            useSSL: false,
            accessKey: 'x',
            secretKey: 'x',
            bucket: 'b',
        } as any,
        s3PathPrefix: 'prefix',
        byteRange: false,
        byteRangeMaxFileSizeBytes: 500 * 1024 * 1024,
        ...overrides,
    };

    return new SegmentPipeline(
        config,
        {} as any,
        mockS3Service as any,
        new Logger('Test')
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

        /** The mocked S3 client the pipeline was built with. */
        const s3Of = (pipeline: SegmentPipeline) => (pipeline as any).s3Service;

        /** Every object key `uploadFile` was actually asked to send. */
        const sentKeys = (pipeline: SegmentPipeline): string[] =>
            s3Of(pipeline).uploadFile.mock.calls.map((c: unknown[]) => c[3]);

        it('should skip concat.txt from uploads', async () => {
            // Both are the encoder's own scratch files. The packer removes its
            // list in a finally, so `pack-list.txt` is belt-and-braces — a
            // crashed pack must not put its scratch file in the delivered output.
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            writeFileSync(join(tmpDir, 'concat.txt'), 'ffconcat version 1.0\n');
            writeFileSync(join(tmpDir, 'pack-list.txt'), 'thumb_0001.jpg\n');
            mkdirSync(join(tmpDir, 'stream_0'));
            writeFileSync(
                join(tmpDir, 'stream_0', 'playlist.m3u8'),
                '#EXTM3U\n'
            );

            const pipeline = makePipeline(tmpDir);
            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toContain('prefix/master.m3u8');
            expect(keys).toContain('prefix/stream_0/playlist.m3u8');
            expect(keys).not.toContain('prefix/concat.txt');
            expect(keys).not.toContain('prefix/pack-list.txt');
            expect(sentKeys(pipeline)).not.toContain('prefix/pack-list.txt');
        });

        it('should upload all files when no concat.txt present', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            mkdirSync(join(tmpDir, 'thumbnails'));
            writeFileSync(
                join(tmpDir, 'thumbnails', 'thumbnails.vtt'),
                'WEBVTT\n'
            );

            const pipeline = makePipeline(tmpDir);
            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toContain('prefix/master.m3u8');
            expect(keys).toContain('prefix/thumbnails/thumbnails.vtt');
        });

        it('leaves alone what the streaming phase already sent', async () => {
            // Every `init.mp4` is uploaded during encoding with
            // `deleteAfterUpload: false`, because playlist rewriting still needs
            // it — so it is still on disk when this walks the directory. Without
            // the check it was sent to S3 a second time and appeared twice in the
            // completion `files` list.
            mkdirSync(join(tmpDir, 'stream_0'));
            const initPath = join(tmpDir, 'stream_0', 'init.mp4');
            writeFileSync(initPath, 'ftyp');
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');

            const pipeline = makePipeline(tmpDir);
            // The streaming phase, as `processStream` runs it.
            (pipeline as any).enqueueUpload({
                filePath: initPath,
                objectKey: 'prefix/stream_0/init.mp4',
                deleteAfterUpload: false,
            });
            await (pipeline as any).waitForUploads();

            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).not.toContain('prefix/stream_0/init.mp4');
            expect(keys).toContain('prefix/master.m3u8');
            expect(
                pipeline.keys.filter((k) => k === 'prefix/stream_0/init.mp4')
            ).toHaveLength(1);
            expect(
                sentKeys(pipeline).filter(
                    (k) => k === 'prefix/stream_0/init.mp4'
                )
            ).toHaveLength(1);
        });

        it('holds the uploads to the configured concurrency', async () => {
            for (let i = 0; i < 6; i++) {
                writeFileSync(join(tmpDir, `file_${i}.m3u8`), '#EXTM3U\n');
            }

            const pipeline = makePipeline(tmpDir, { uploadConcurrency: 2 });
            let inFlight = 0;
            let peak = 0;
            s3Of(pipeline).uploadFile = vi.fn(async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight--;
            });

            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toHaveLength(6);
            expect(peak).toBe(2);
        });

        it('reports each file as it lands, against a total that does not move', async () => {
            for (let i = 0; i < 4; i++) {
                writeFileSync(join(tmpDir, `file_${i}.m3u8`), '#EXTM3U\n');
            }

            const pipeline = makePipeline(tmpDir);
            const reports: [number, number][] = [];

            await pipeline.uploadRemainingFiles(tmpDir, {
                onFileProgress: (done, total) => reports.push([done, total]),
            });

            expect(reports).toEqual([
                [1, 4],
                [2, 4],
                [3, 4],
                [4, 4],
            ]);
        });

        it('stays silent on the segment progress emitter while it runs', async () => {
            // `executeUpload` emits after every file, and what it emits is the
            // segment-based figure — `uploading: 100`, since the segments are
            // long done. Interleaved with the per-file percentage the bar jitters
            // between the two, so the emitter is suppressed for the duration.
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            writeFileSync(join(tmpDir, 'other.m3u8'), '#EXTM3U\n');

            const onProgress = vi.fn();
            const pipeline = makePipeline(tmpDir, {
                estimatedTotalSegments: 10,
                onProgress,
            });

            await pipeline.uploadRemainingFiles(tmpDir);

            expect(onProgress).not.toHaveBeenCalled();

            // And it is only suppressed for the duration — a later upload still
            // reports, so nothing is left permanently mute.
            (pipeline as any).enqueueUpload({
                filePath: join(tmpDir, 'master.m3u8'),
                objectKey: 'prefix/late.m3u8',
                deleteAfterUpload: false,
            });
            await (pipeline as any).waitForUploads();

            expect(onProgress).toHaveBeenCalled();
        });

        /**
         * `executeUpload` backs off 1s then 2s between its three attempts.
         * Faking only `setTimeout` collapses that wait while leaving the real
         * file I/O this path depends on to complete on its own.
         */
        async function settle<T>(work: Promise<T>): Promise<T> {
            let done = false;
            const tracked = work.then(
                (value) => {
                    done = true;
                    return value;
                },
                (err) => {
                    done = true;
                    throw err;
                }
            );
            tracked.catch(() => {}); // The caller re-awaits and gets the rejection.
            for (let i = 0; i < 100 && !done; i++) {
                await new Promise((r) => setImmediate(r));
                await vi.advanceTimersByTimeAsync(2000);
            }
            return tracked;
        }

        it('retries a file that fails, and still counts it once', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');

            const pipeline = makePipeline(tmpDir);
            let attempts = 0;
            s3Of(pipeline).uploadFile = vi.fn(async () => {
                if (++attempts < 3) throw new Error('connection reset');
            });
            const reports: number[] = [];

            vi.useFakeTimers({ toFake: ['setTimeout'] });
            try {
                const keys = await settle(
                    pipeline.uploadRemainingFiles(tmpDir, {
                        onFileProgress: (done) => reports.push(done),
                    })
                );
                expect(keys).toEqual(['prefix/master.m3u8']);
            } finally {
                vi.useRealTimers();
            }

            expect(attempts).toBe(3);
            expect(reports).toEqual([1]);
            expect(pipeline.keys).toEqual(['prefix/master.m3u8']);
        });

        it('rejects when a file cannot be uploaded at all', async () => {
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');

            const pipeline = makePipeline(tmpDir);
            s3Of(pipeline).uploadFile = vi
                .fn()
                .mockRejectedValue(new Error('bucket does not exist'));

            vi.useFakeTimers({ toFake: ['setTimeout'] });
            try {
                await expect(
                    settle(pipeline.uploadRemainingFiles(tmpDir))
                ).rejects.toThrow(/after 3 attempts/);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    /**
     * The segment total is partly estimated — streams × ceil(duration /
     * segmentDuration) — and FFmpeg routinely produces a few more than that, so
     * keyframe alignment and trim concatenation both push the real count past
     * it. Divided by the estimate regardless, the upload bar read 102%.
     */
    describe('progress percentages', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-progress-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        function progressAfter(
            uploaded: number,
            produced: number,
            estimate: number
        ) {
            const seen: number[] = [];
            const pipeline = makePipeline(tmpDir, {
                estimatedTotalSegments: estimate,
                onProgress: (p) => {
                    if (p.uploading != null) seen.push(p.uploading);
                },
            });
            (pipeline as any).segmentsUploaded = uploaded;
            (pipeline as any).totalSegmentsProduced = produced;
            (pipeline as any).emitProgress();
            return seen.at(-1);
        }

        it('never reports more than 100%', () => {
            // 102 uploaded against an estimate of 100 is exactly the reported bug.
            expect(progressAfter(102, 102, 100)).toBe(100);
        });

        it('measures against the real count once it exceeds the estimate', () => {
            // 60 of the 120 actually produced is halfway, whatever the estimate
            // guessed — measured against the estimate it would read 60% and
            // overstate the work done.
            expect(progressAfter(60, 120, 100)).toBe(50);
        });

        it('uses the estimate while it still holds', () => {
            // The estimate is preferred precisely because it does not grow
            // mid-encode, which would make the bar jump about.
            expect(progressAfter(25, 10, 100)).toBe(25);
        });

        it('reports nothing rather than dividing by zero', () => {
            expect(progressAfter(0, 0, 0)).toBeUndefined();
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
