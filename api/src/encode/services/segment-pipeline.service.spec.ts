import {
    existsSync,
    mkdtempSync,
    writeFileSync,
    mkdirSync,
    readFileSync,
    rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Logger } from '@nestjs/common';
import { readBaseMediaDecodeTime } from './fmp4-timeline.js';
import {
    SegmentPipeline,
    type DurableSegment,
    type SegmentPipelineConfig,
} from './segment-pipeline.service.js';
import { resumePlan, resumePoint, type ResumeRecord } from './encode-resume.js';

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

/**
 * Byte-range packing, as it now works: several streams share one chunk chain
 * under `media/`, rather than each stream packing a chain inside its own
 * directory.
 *
 * The reason is the edge, not the encoder: the CDN class this targets serves a
 * requested range once its pull of the whole object reaches it, so one chunk
 * pull warms every rendition of an angle and an ABR step-up never lands on a
 * cold object. Byte order inside a chunk only decides how long a request into
 * a cold chunk waits, which is why arrival order may interleave streams freely
 * and block order groups them inside short blocks.
 */
describe('SegmentPipeline — shared chunk chains', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-chunks-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    /** A stream directory with `sizes.length` segments of the given sizes. */
    function seedStream(
        dirName: string,
        sizes: number[],
        opts?: { init?: string[]; segmentDuration?: number }
    ): void {
        const dir = join(tmpDir, dirName);
        mkdirSync(dir, { recursive: true });
        for (const initName of opts?.init ?? []) {
            writeFileSync(join(dir, initName), 'ftyp');
        }

        const segDur = (opts?.segmentDuration ?? 6).toFixed(6);
        const lines = [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MAP:URI="init.mp4"',
        ];
        sizes.forEach((size, i) => {
            const name = `segment_${String(i).padStart(5, '0')}.m4s`;
            writeFileSync(
                join(dir, name),
                Buffer.alloc(size, dirName[7] ?? 'x')
            );
            lines.push(`#EXTINF:${segDur},`, name);
        });
        lines.push('#EXT-X-ENDLIST', '');
        writeFileSync(join(dir, 'playlist.m3u8'), lines.join('\n'));
    }

    /**
     * Chunks are deleted the moment they are uploaded, so what was in one has to
     * be captured as it goes past.
     */
    function captureUploads(pipeline: SegmentPipeline): Map<string, Buffer> {
        const uploads = new Map<string, Buffer>();
        (pipeline as any).s3Service.uploadFile = vi.fn(
            async (
                _client: unknown,
                _bucket: string,
                filePath: string,
                key: string
            ) => {
                uploads.set(key, readFileSync(filePath));
            }
        );
        return uploads;
    }

    const readPlaylist = (dirName: string): string[] =>
        readFileSync(join(tmpDir, dirName, 'playlist.m3u8'), 'utf-8').split(
            '\n'
        );

    describe('durable segments, for continuing a failed encode', () => {
        /** A minimal fMP4 segment: styp, then a moof whose tfdt is `tfdt`. */
        function fmp4Segment(tfdt: number): Buffer {
            const box = (type: string, ...content: Buffer[]) => {
                const body = Buffer.concat(content);
                const head = Buffer.alloc(8);
                head.writeUInt32BE(body.length + 8, 0);
                head.write(type, 4, 4, 'latin1');
                return Buffer.concat([head, body]);
            };
            const tfdtBox = Buffer.alloc(12);
            tfdtBox.writeUInt8(1, 0);
            tfdtBox.writeBigUInt64BE(BigInt(tfdt), 4);
            return Buffer.concat([
                box('styp', Buffer.from('msdh', 'latin1')),
                box('moof', box('traf', box('tfdt', tfdtBox))),
                box('mdat', Buffer.alloc(16)),
            ]);
        }

        function seedVideo(dirName: string, starts: number[]): void {
            const dir = join(tmpDir, dirName);
            mkdirSync(dir, { recursive: true });
            const lines = [
                '#EXTM3U',
                '#EXT-X-TARGETDURATION:6',
                '#EXT-X-MAP:URI="init.mp4"',
            ];
            starts.forEach((start, i) => {
                const name = `segment_${String(i).padStart(5, '0')}.m4s`;
                writeFileSync(join(dir, name), fmp4Segment(start));
                lines.push('#EXTINF:6.000000,', name);
            });
            lines.push('#EXT-X-ENDLIST', '');
            writeFileSync(join(dir, 'playlist.m3u8'), lines.join('\n'));
        }

        it('reports segments only once the chunk holding them has uploaded, with their start times', async () => {
            seedVideo('stream_720p', [0, 540000]);
            const durable: unknown[] = [];
            let release!: () => void;
            const uploaded = new Promise<void>((r) => (release = r));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_720p: 'v0' },
                onDurable: (segments) => durable.push(...segments),
            });
            (pipeline as any).s3Service.uploadFile = vi.fn(() => uploaded);

            const draining = pipeline.drain();
            await new Promise((r) => setTimeout(r, 50));
            expect(durable).toEqual([]);

            release();
            await draining;
            expect(durable).toEqual([
                expect.objectContaining({
                    stream: 'stream_720p',
                    index: 0,
                    tfdt: 0,
                    mediaFile: 'media/v0_0.m4s',
                    offset: 0,
                }),
                expect.objectContaining({
                    stream: 'stream_720p',
                    index: 1,
                    tfdt: 540000,
                    mediaFile: 'media/v0_0.m4s',
                }),
            ]);
        });

        it('reports nothing for a chunk whose upload failed', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            seedVideo('stream_720p', [0]);
            const durable: unknown[] = [];
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_720p: 'v0' },
                onDurable: (segments) => durable.push(...segments),
            });
            (pipeline as any).s3Service.uploadFile = vi
                .fn()
                .mockRejectedValue(new Error('offline'));

            const draining = pipeline.drain().catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(5000);
            expect(await draining).toBeInstanceOf(Error);
            expect(durable).toEqual([]);
            vi.useRealTimers();
        });

        it("names a later run's chunks apart, so a late upload from a failed run cannot overwrite them", async () => {
            seedVideo('stream_720p', [0]);
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_720p: 'v0' },
                attempt: 2,
            });
            const uploads = captureUploads(pipeline);

            await pipeline.drain();

            expect([...uploads.keys()]).toContain('prefix/media/v0_r2_0.m4s');
        });

        describe('a continued run', () => {
            const box = (type: string, ...content: Buffer[]) => {
                const body = Buffer.concat(content);
                const head = Buffer.alloc(8);
                head.writeUInt32BE(body.length + 8, 0);
                head.write(type, 4, 4, 'latin1');
                return Buffer.concat([head, body]);
            };
            /** An init with a 90 kHz track and the given sample description. */
            const init = (codec: string) => {
                const mdhd = Buffer.alloc(24);
                mdhd.writeUInt32BE(90000, 12);
                return box(
                    'moov',
                    box(
                        'trak',
                        box(
                            'mdia',
                            box('mdhd', mdhd),
                            box(
                                'minf',
                                box(
                                    'stbl',
                                    box('stsd', Buffer.from(codec, 'latin1'))
                                )
                            )
                        )
                    )
                );
            };

            /** This run wrote segments 2 and 3, starting from 0 as a fresh ffmpeg does. */
            function seedResumedRun(newCodec: string): void {
                const dir = join(tmpDir, 'stream_720p');
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'init.mp4'), init(newCodec));
                writeFileSync(join(dir, 'segment_00002.m4s'), fmp4Segment(0));
                writeFileSync(
                    join(dir, 'segment_00003.m4s'),
                    fmp4Segment(540000)
                );
                writeFileSync(
                    join(dir, 'playlist.m3u8'),
                    [
                        '#EXTM3U',
                        '#EXT-X-VERSION:7',
                        '#EXT-X-TARGETDURATION:6',
                        '#EXT-X-MEDIA-SEQUENCE:2',
                        '#EXT-X-PLAYLIST-TYPE:VOD',
                        '#EXT-X-INDEPENDENT-SEGMENTS',
                        '#EXT-X-MAP:URI="init.mp4"',
                        '#EXTINF:6.000000,',
                        'segment_00002.m4s',
                        '#EXTINF:6.000000,',
                        'segment_00003.m4s',
                        '#EXT-X-ENDLIST',
                        '',
                    ].join('\n')
                );
            }

            const resume = (previousCodec: string) => ({
                startIndex: 2,
                startTfdt: { stream_720p: 1080000 },
                reused: {
                    stream_720p: [0, 1].map((i) => ({
                        stream: 'stream_720p',
                        file: `segment_0000${i}.m4s`,
                        index: i,
                        tfdt: i * 540000,
                        nextTfdt: (i + 1) * 540000,
                        mediaFile: 'media/v0_0.m4s',
                        offset: i * 100,
                        length: 100,
                    })),
                },
                previousInits: { stream_720p: init(previousCodec) },
            });

            it('moves the new segments onto the old timeline and puts the reused ones back in front', async () => {
                seedResumedRun('avc1');
                const durable: { index: number; tfdt?: number }[] = [];
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                    attempt: 1,
                    resume: resume('avc1'),
                    onDurable: (segments) => durable.push(...segments),
                });
                captureUploads(pipeline);

                await pipeline.drain();

                expect(durable.map((d) => [d.index, d.tfdt])).toEqual([
                    [2, 1080000],
                    [3, 1620000],
                ]);
                const playlist = readPlaylist('stream_720p').join('\n');
                expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
                expect(playlist.match(/#EXT-X-MAP/g)).toHaveLength(1);
                expect(playlist).not.toContain('DISCONTINUITY');
                const uris = readPlaylist('stream_720p').filter(
                    (l) => l && !l.startsWith('#')
                );
                expect(uris).toEqual([
                    '../media/v0_0.m4s',
                    '../media/v0_0.m4s',
                    '../media/v0_r1_0.m4s',
                    '../media/v0_r1_0.m4s',
                ]);
                expect(playlist).toContain('#EXT-X-BYTERANGE:100@100');
                expect(playlist.match(/#EXTINF:6\.000000,/g)).toHaveLength(4);
            });

            it('keeps the old init for the reused half when the codec settings differ', async () => {
                seedResumedRun('hvc1');
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                    attempt: 1,
                    resume: resume('avc1'),
                });
                captureUploads(pipeline);

                await pipeline.drain();

                const playlist = readPlaylist('stream_720p').join('\n');
                expect(playlist).toMatch(
                    /#EXT-X-MAP:URI="init_r0\.mp4"[\s\S]*#EXT-X-DISCONTINUITY[\s\S]*#EXT-X-MAP:URI="init\.mp4"/
                );
                expect(
                    readFileSync(join(tmpDir, 'stream_720p', 'init_r0.mp4'))
                ).toEqual(init('avc1'));
            });

            it('throws away the warm-up segment a continued audio stream starts with', async () => {
                // This run began at segment 1 to warm the encoder up; 1 goes, 2 and 3 stay.
                seedResumedRun('avc1');
                writeFileSync(
                    join(tmpDir, 'stream_720p', 'segment_00001.m4s'),
                    fmp4Segment(0)
                );
                const playlistPath = join(
                    tmpDir,
                    'stream_720p',
                    'playlist.m3u8'
                );
                writeFileSync(
                    playlistPath,
                    readFileSync(playlistPath, 'utf8').replace(
                        '#EXTINF:6.000000,\nsegment_00002.m4s',
                        '#EXTINF:6.000000,\nsegment_00001.m4s\n#EXTINF:6.000000,\nsegment_00002.m4s'
                    )
                );
                writeFileSync(
                    join(tmpDir, 'stream_720p', 'segment_00002.m4s'),
                    fmp4Segment(540000)
                );
                writeFileSync(
                    join(tmpDir, 'stream_720p', 'segment_00003.m4s'),
                    fmp4Segment(1080000)
                );
                const durable: { index: number; tfdt?: number }[] = [];
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                    attempt: 1,
                    resume: resume('avc1'),
                    onDurable: (segments) => durable.push(...segments),
                });
                captureUploads(pipeline);

                await pipeline.drain();

                expect(durable.map((d) => [d.index, d.tfdt])).toEqual([
                    [2, 1080000],
                    [3, 1620000],
                ]);
                const uris = readPlaylist('stream_720p').filter(
                    (l) => l && !l.startsWith('#')
                );
                expect(uris).toHaveLength(4);
                expect(uris).not.toContain('segment_00001.m4s');
            });

            it('refuses to join when this run does not start at the restart segment', async () => {
                seedResumedRun('avc1');
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                    attempt: 1,
                    resume: { ...resume('avc1'), startIndex: 1 },
                });
                captureUploads(pipeline);

                await expect(pipeline.drain()).rejects.toThrow(
                    /expected segment 1 first/
                );
            });
        });

        it('starts the bars where the run it continues left off', () => {
            const progress: unknown[] = [];
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                encryptionKey: Buffer.alloc(16),
                estimatedTotalSegments: 100,
                alreadyDone: 40,
                onProgress: (p) => progress.push(p),
            });

            pipeline.start();
            pipeline.abort();

            expect(progress[0]).toEqual(
                expect.objectContaining({ encrypting: 40, uploading: 40 })
            );
        });

        describe('keeping what never reached storage', () => {
            it('hands on the open chunk, closed, with the segments it holds and the size it must have', async () => {
                seedVideo('stream_720p', [0, 540000]);
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                });
                (pipeline as any).s3Service.uploadFile = vi.fn(
                    () => new Promise(() => {})
                );
                // Chunk 0 closes only after 20 s worth; two 6 s segments stay open.
                await (pipeline as any).poll();

                pipeline.abort();
                const kept = await pipeline.salvage();

                expect(kept).toHaveLength(1);
                expect(kept[0].objectKey).toBe('prefix/media/v0_0.m4s');
                expect(kept[0].segments.map((s) => s.index)).toEqual([0, 1]);
                expect(readFileSync(kept[0].filePath).length).toBe(
                    kept[0].size
                );
            });

            it('drops a file whose size is not what its segments say', async () => {
                seedVideo('stream_720p', [0]);
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_720p: 'v0' },
                });
                await (pipeline as any).poll();
                pipeline.abort();
                await Promise.all((pipeline as any).closing);
                writeFileSync(join(tmpDir, 'media', 'v0_0.m4s'), 'truncated');

                expect(await pipeline.salvage()).toEqual([]);
            });

            it('uploads a kept file and only then reports its segments as stored', async () => {
                const file = join(tmpDir, 'kept.m4s');
                writeFileSync(file, Buffer.alloc(32));
                const durable: unknown[] = [];
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    onDurable: (segments) => durable.push(...segments),
                });
                const s3 = (pipeline as any).s3Service;

                await pipeline.uploadSalvaged([
                    {
                        filePath: file,
                        objectKey: 'prefix/media/v0_0.m4s',
                        size: 32,
                        segments: [
                            {
                                stream: 'stream_720p',
                                file: 'segment_00000.m4s',
                                index: 0,
                                mediaFile: 'media/v0_0.m4s',
                                offset: 0,
                                length: 32,
                            },
                        ],
                    },
                ]);

                expect(s3.uploadFile).toHaveBeenCalledWith(
                    expect.anything(),
                    'b',
                    file,
                    'prefix/media/v0_0.m4s',
                    expect.any(Function)
                );
                expect(durable).toHaveLength(1);
            });
        });

        it('starts no queued upload once aborted', async () => {
            seedVideo('stream_720p', [0]);
            const pipeline = makePipeline(tmpDir, {
                byteRange: false,
                uploadConcurrency: 1,
            });
            const s3 = (pipeline as any).s3Service;
            s3.uploadFile = vi.fn(() => new Promise(() => {}));
            (pipeline as any).enqueueUpload({
                filePath: 'a',
                objectKey: 'k1',
                deleteAfterUpload: false,
            });
            (pipeline as any).enqueueUpload({
                filePath: 'b',
                objectKey: 'k2',
                deleteAfterUpload: false,
            });

            pipeline.abort();

            expect(s3.uploadFile).toHaveBeenCalledTimes(1);
            expect((pipeline as any).uploadQueue).toHaveLength(0);
        });
    });

    it('interleaves two renditions of an angle into one chunk, each at its own offsets', async () => {
        seedStream('stream_1080p', [10, 20]);
        seedStream('stream_720p', [5, 7]);

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: {
                stream_1080p: 'v0',
                stream_720p: 'v0',
            },
            segmentDurationSeconds: 6,
        });
        const uploads = captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        // One object for both renditions, holding both in arrival order —
        // directory order here, since a poll walks the directories in turn.
        expect([...uploads.keys()]).toEqual(['prefix/media/v0_0.m4s']);
        expect(uploads.get('prefix/media/v0_0.m4s')!.length).toBe(42);

        // Each playlist addresses its own bytes inside the shared object, and
        // reaches it one level up: playlists stay in their stream directories.
        expect(readPlaylist('stream_1080p')).toEqual([
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:6.000000,',
            '#EXT-X-BYTERANGE:10@0',
            '../media/v0_0.m4s',
            '#EXTINF:6.000000,',
            '#EXT-X-BYTERANGE:20@10',
            '../media/v0_0.m4s',
            '#EXT-X-ENDLIST',
            '',
        ]);
        expect(
            readPlaylist('stream_720p').filter((l) => l.includes('@'))
        ).toEqual(['#EXT-X-BYTERANGE:5@30', '#EXT-X-BYTERANGE:7@35']);
    });

    it('packs every audio group into one chain of its own, under its own cap', async () => {
        seedStream('stream_hd_HD_Audio', [10]);
        seedStream('stream_sd_SD_Audio', [10]);
        seedStream('stream_1080p', [10]);

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: {
                stream_1080p: 'v0',
                stream_hd_HD_Audio: 'a',
                stream_sd_SD_Audio: 'a',
            },
            // A cap the video chain would not notice, so a roll in the audio
            // chain can only have come from the audio cap.
            byteRangeMaxFileSizeBytes: 1024,
            audioByteRangeMaxFileSizeBytes: 15,
            segmentDurationSeconds: 6,
        });
        const uploads = captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        expect([...uploads.keys()].sort()).toEqual([
            'prefix/media/a_0.m4s',
            'prefix/media/a_1.m4s',
            'prefix/media/v0_0.m4s',
        ]);
        expect(
            readPlaylist('stream_hd_HD_Audio').filter((l) =>
                l.startsWith('../media/')
            )
        ).toEqual(['../media/a_0.m4s']);
        expect(
            readPlaylist('stream_sd_SD_Audio').filter((l) =>
                l.startsWith('../media/')
            )
        ).toEqual(['../media/a_1.m4s']);
    });

    it('closes the first chunk early and lets every later one grow to the cap', async () => {
        // Ten-second segments, so the ~20 s first-chunk target is two of them
        // for a one-stream chain. After that only the byte cap closes a chunk:
        // 25 bytes takes two 10-byte segments and refuses the third.
        seedStream('stream_1080p', [10, 10, 10, 10, 10], {
            segmentDuration: 10,
        });

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: { stream_1080p: 'v0' },
            byteRangeMaxFileSizeBytes: 25,
            segmentDurationSeconds: 10,
        });
        const uploads = captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        expect(
            readPlaylist('stream_1080p').filter((l) =>
                l.startsWith('../media/')
            )
        ).toEqual([
            '../media/v0_0.m4s',
            '../media/v0_0.m4s',
            '../media/v0_1.m4s',
            '../media/v0_1.m4s',
            '../media/v0_2.m4s',
        ]);
        expect(uploads.get('prefix/media/v0_0.m4s')!.length).toBe(20);
        expect(uploads.get('prefix/media/v0_1.m4s')!.length).toBe(20);
        expect(uploads.get('prefix/media/v0_2.m4s')!.length).toBe(10);
    });

    it('says so when one segment is bigger than the whole cap', async () => {
        // Nothing fails and playback works — the chunk is simply over the edge's
        // cacheable maximum and every request for it goes to origin, for good.
        const warn = vi
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => {});
        seedStream('stream_1080p', [100]);

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: { stream_1080p: 'v0' },
            byteRangeMaxFileSizeBytes: 50,
            segmentDurationSeconds: 6,
        });
        captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        expect(
            warn.mock.calls.some((c) =>
                String(c[0]).includes('over the 50-byte chunk cap')
            )
        ).toBe(true);
    });

    it('gives a directory nothing mapped a chain to itself rather than failing', async () => {
        const warn = vi
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => {});
        seedStream('stream_surprise', [10]);

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: { stream_1080p: 'v0' },
            segmentDurationSeconds: 6,
        });
        const uploads = captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        expect([...uploads.keys()]).toEqual([
            'prefix/media/stream_surprise_0.m4s',
        ]);
        expect(
            warn.mock.calls.some((c) =>
                String(c[0]).includes('no chunk chain configured')
            )
        ).toBe(true);
    });

    /**
     * The fMP4 init must NOT be uploaded while the encode runs. FFmpeg creates
     * the file empty at muxer start and fills it moments later; an upload on
     * first sight races that write, and the `uploadedKeys` dedup in
     * `uploadRemainingFiles` then refuses to send the finished file behind the
     * truncated one — a zero-byte init in the bucket and a black frame at
     * playback. It ships with the remaining files at the end, complete by
     * construction, and loses nothing by waiting: nothing can play from S3
     * before the encode completes.
     */
    it('leaves the init for uploadRemainingFiles instead of racing ffmpeg for it', async () => {
        seedStream('stream_1080p', [10], { init: ['init.mp4'] });
        seedStream('stream_720p', [10], {
            init: ['init_0.mp4', 'init_1.mp4'],
        });

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
            segmentDurationSeconds: 6,
        });
        captureUploads(pipeline);

        await (pipeline as any).poll();
        await (pipeline as any).poll();
        await pipeline.drain();

        const streamedInitKeys = (
            (pipeline as any).s3Service.uploadFile.mock.calls as unknown[][]
        )
            .map((c) => c[3] as string)
            .filter((k) => k.includes('init'));
        expect(streamedInitKeys).toEqual([]);

        // The final sweep is what sends them, once each, whatever ffmpeg
        // named them.
        const remaining = await pipeline.uploadRemainingFiles(tmpDir);
        expect(remaining.filter((k) => k.includes('init')).sort()).toEqual([
            'prefix/stream_1080p/init.mp4',
            'prefix/stream_720p/init_0.mp4',
            'prefix/stream_720p/init_1.mp4',
        ]);
    });

    it('preserves spliced smart-cut structure through the byte-range rewrite', async () => {
        // A quick-trim playlist: three parts joined by discontinuities, the
        // first two opening their own init, the third continuing part two's.
        // The rewrite must byte-range the segments without touching any of it.
        const dir = join(tmpDir, 'stream_480p');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'init_0.mp4'), 'ftyp');
        writeFileSync(join(dir, 'init_100000.mp4'), 'ftyp');
        const sizes: Record<string, number> = {
            'segment_0000000.m4s': 4,
            'segment_0100000.m4s': 10,
            'segment_0100001.m4s': 20,
            'segment_0200000.m4s': 6,
        };
        for (const [name, size] of Object.entries(sizes)) {
            writeFileSync(join(dir, name), Buffer.alloc(size, 'q'));
        }
        writeFileSync(
            join(dir, 'playlist.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-TARGETDURATION:6',
                '#EXT-X-MEDIA-SEQUENCE:0',
                '#EXT-X-PLAYLIST-TYPE:VOD',
                '#EXT-X-MAP:URI="init_0.mp4"',
                '#EXTINF:0.250000,',
                'segment_0000000.m4s',
                '#EXT-X-DISCONTINUITY',
                '#EXT-X-MAP:URI="init_100000.mp4"',
                '#EXTINF:6.000000,',
                'segment_0100000.m4s',
                '#EXTINF:2.060000,',
                'segment_0100001.m4s',
                '#EXT-X-DISCONTINUITY',
                '#EXTINF:0.880000,',
                'segment_0200000.m4s',
                '#EXT-X-ENDLIST',
                '',
            ].join('\n')
        );

        const pipeline = makePipeline(tmpDir, {
            byteRange: true,
            streamChains: { stream_480p: 'v0' },
            segmentDurationSeconds: 6,
        });
        captureUploads(pipeline);

        await (pipeline as any).poll();
        await pipeline.drain();

        expect(readPlaylist('stream_480p')).toEqual([
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-MAP:URI="init_0.mp4"',
            '#EXTINF:0.250000,',
            '#EXT-X-BYTERANGE:4@0',
            '../media/v0_0.m4s',
            '#EXT-X-DISCONTINUITY',
            '#EXT-X-MAP:URI="init_100000.mp4"',
            '#EXTINF:6.000000,',
            '#EXT-X-BYTERANGE:10@4',
            '../media/v0_0.m4s',
            '#EXTINF:2.060000,',
            '#EXT-X-BYTERANGE:20@14',
            '../media/v0_0.m4s',
            '#EXT-X-DISCONTINUITY',
            '#EXTINF:0.880000,',
            '#EXT-X-BYTERANGE:6@34',
            '../media/v0_0.m4s',
            '#EXT-X-ENDLIST',
            '',
        ]);
    });

    /**
     * Block order: time order between blocks, each stream's segments together
     * inside a block, so a download reaches a stream in one range per block.
     *
     * Ten-second segments throughout unless a test says otherwise, so block 0
     * (the first chunk's ~20 s) is two segments per stream, and a 20 s block is
     * two more.
     */
    describe('grouped by stream in blocks', () => {
        /** Every seeded segment's bytes, keyed `<stream>/<file>`, to find it again in a chunk. */
        let originals: Map<string, Buffer>;
        /** Each stream's segment files in playlist order. */
        let seeded: Map<string, string[]>;

        beforeEach(() => {
            originals = new Map();
            seeded = new Map();
        });

        const name = (i: number) => `segment_${String(i).padStart(5, '0')}.m4s`;

        /** One segment, filled with a tag naming it, so a misplaced range shows. */
        function writeTagged(stream: string, file: string, size: number): void {
            const bytes = Buffer.alloc(size, `${stream}/${file}|`);
            mkdirSync(join(tmpDir, stream), { recursive: true });
            writeFileSync(join(tmpDir, stream, file), bytes);
            originals.set(`${stream}/${file}`, bytes);
        }

        function writePlaylist(stream: string, files: string[]): void {
            mkdirSync(join(tmpDir, stream), { recursive: true });
            const lines = [
                '#EXTM3U',
                '#EXT-X-TARGETDURATION:10',
                '#EXT-X-MAP:URI="init.mp4"',
                ...files.flatMap((f) => ['#EXTINF:10.000000,', f]),
                '#EXT-X-ENDLIST',
                '',
            ];
            writeFileSync(
                join(tmpDir, stream, 'playlist.m3u8'),
                lines.join('\n')
            );
            seeded.set(stream, files);
        }

        /**
         * A stream whose playlist lists `sizes.length` segments, of which the
         * first `present` are on disk; the rest are written later with `more`.
         */
        function seedTagged(
            stream: string,
            sizes: number[],
            opts?: { present?: number; files?: string[] }
        ): { more: (upTo: number) => void } {
            const files = opts?.files ?? sizes.map((_, i) => name(i));
            writePlaylist(stream, files);
            let written = 0;
            const more = (upTo: number) => {
                for (; written < upTo; written++) {
                    writeTagged(stream, files[written], sizes[written]);
                }
            };
            more(opts?.present ?? sizes.length);
            return { more };
        }

        const sizesOf = (count: number, base = 40) =>
            Array.from({ length: count }, (_, i) => base + i);

        interface Placed {
            stream: string;
            file: string;
            /** Its place in the stream's playlist. */
            position: number;
            chunk: string;
            offset: number;
            length: number;
        }

        /** Where each stream's playlist says its segments are. */
        function placements(): Placed[] {
            const out: Placed[] = [];
            for (const [stream, files] of seeded) {
                const lines = readPlaylist(stream);
                const ranges: Omit<Placed, 'stream' | 'file' | 'position'>[] =
                    [];
                lines.forEach((line, i) => {
                    const m = /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/.exec(line);
                    if (!m) return;
                    const uri = lines[i + 1];
                    expect(uri).toMatch(/^\.\.\/media\//);
                    ranges.push({
                        chunk: uri.slice('../media/'.length),
                        length: Number(m[1]),
                        offset: Number(m[2]),
                    });
                });
                // Every segment the playlist lists is packed, and only once.
                expect(ranges).toHaveLength(files.length);
                ranges.forEach((r, position) =>
                    out.push({ stream, file: files[position], position, ...r })
                );
            }
            return out;
        }

        const chunkNumber = (chunk: string) =>
            Number(/_(\d+)\.m4s$/.exec(chunk)![1]);

        const chainOf = (chunk: string) => /^(.+)_\d+\.m4s$/.exec(chunk)![1];

        /**
         * What every block layout must hold: each range is the segment it
         * names, the ranges of a chunk tile it with no gap or overlap, each
         * chain's blocks follow in time order, and inside a block each stream
         * is one run of its own segments in order. Returns the segments in
         * byte order, chain by chain.
         */
        function verifyBlockLayout(
            uploads: Map<string, Buffer>,
            opts: { lead: number; perBlock: number; splitBlocks?: boolean }
        ): Placed[] {
            const blockOf = (p: number) =>
                p < opts.lead
                    ? 0
                    : 1 + Math.floor((p - opts.lead) / opts.perBlock);
            const placed = placements();
            expect(placed).toHaveLength(originals.size);

            for (const p of placed) {
                const chunk = uploads.get(`prefix/media/${p.chunk}`);
                expect(chunk, p.chunk).toBeDefined();
                expect(chunk!.subarray(p.offset, p.offset + p.length)).toEqual(
                    originals.get(`${p.stream}/${p.file}`)
                );
            }

            const byChunk = new Map<string, Placed[]>();
            for (const p of placed) {
                byChunk.set(p.chunk, [...(byChunk.get(p.chunk) ?? []), p]);
            }
            for (const [chunk, inChunk] of byChunk) {
                inChunk.sort((a, b) => a.offset - b.offset);
                let end = 0;
                for (const p of inChunk) {
                    expect(p.offset, `${chunk} at ${p.offset}`).toBe(end);
                    end += p.length;
                }
                expect(uploads.get(`prefix/media/${chunk}`)!.length).toBe(end);
            }

            // Each chain is its own run of blocks, written independently.
            const chains = [...new Set([...byChunk.keys()].map(chainOf))];
            const ordered: Placed[] = [];
            for (const chain of chains) {
                const inChain = [...byChunk.keys()]
                    .filter((chunk) => chainOf(chunk) === chain)
                    .sort((a, b) => chunkNumber(a) - chunkNumber(b))
                    .flatMap((chunk) => byChunk.get(chunk)!);
                let block = -1;
                let stream = '';
                let position = -1;
                let finished = new Set<string>();
                for (const p of inChain) {
                    const b = blockOf(p.position);
                    expect(
                        b,
                        `${chain} ${p.stream} ${p.position}`
                    ).toBeGreaterThanOrEqual(block);
                    if (b !== block) {
                        block = b;
                        finished = new Set();
                        stream = '';
                    }
                    if (p.stream !== stream) {
                        expect(
                            finished.has(p.stream),
                            `${p.stream} split in block ${b}`
                        ).toBe(false);
                        if (stream) finished.add(stream);
                        stream = p.stream;
                        position = -1;
                    }
                    expect(p.position).toBeGreaterThan(position);
                    position = p.position;
                }
                ordered.push(...inChain);
            }

            if (!opts.splitBlocks) {
                const chunksOfBlock = new Map<string, Set<string>>();
                for (const p of placed) {
                    const key = `${chainOf(p.chunk)} block ${blockOf(p.position)}`;
                    chunksOfBlock.set(
                        key,
                        (chunksOfBlock.get(key) ?? new Set()).add(p.chunk)
                    );
                }
                for (const [key, chunks] of chunksOfBlock) {
                    expect([...chunks], key).toHaveLength(1);
                }
            }
            return ordered;
        }

        const label = (p: Placed) => `${p.chunk} ${p.stream} ${p.position}`;

        it('packs in arrival order with the option off, byte for byte as without it', async () => {
            const run = async (blockSeconds: number | undefined) => {
                rmSync(tmpDir, { recursive: true, force: true });
                mkdirSync(tmpDir, { recursive: true });
                seedTagged('stream_1080p', sizesOf(4));
                seedTagged('stream_720p', sizesOf(4, 60));
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                    segmentDurationSeconds: 10,
                    ...(blockSeconds !== undefined
                        ? { byteRangeBlockSeconds: blockSeconds }
                        : {}),
                });
                const uploads = captureUploads(pipeline);
                await (pipeline as any).poll();
                await pipeline.drain();
                return {
                    uploads,
                    playlists: ['stream_1080p', 'stream_720p'].map((s) =>
                        readPlaylist(s).join('\n')
                    ),
                    placed: placements(),
                };
            };

            const without = await run(undefined);
            const off = await run(0);

            expect(off.uploads).toEqual(without.uploads);
            expect(off.playlists).toEqual(without.playlists);
            // Arrival order: a poll reads one directory after the other, so the
            // first chunk fills with the first stream it reads.
            expect(
                off.placed
                    .sort(
                        (a, b) =>
                            chunkNumber(a.chunk) - chunkNumber(b.chunk) ||
                            a.offset - b.offset
                    )
                    .map(label)
            ).toEqual([
                'v0_0.m4s stream_1080p 0',
                'v0_0.m4s stream_1080p 1',
                'v0_0.m4s stream_1080p 2',
                'v0_0.m4s stream_1080p 3',
                'v0_1.m4s stream_720p 0',
                'v0_1.m4s stream_720p 1',
                'v0_1.m4s stream_720p 2',
                'v0_1.m4s stream_720p 3',
            ]);
        });

        it('groups each stream inside a block, in the chain order, with blocks in time order', async () => {
            seedTagged('stream_1080p', sizesOf(7));
            seedTagged('stream_720p', sizesOf(7, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                // The encode config's order, not the directories'.
                streamChains: { stream_720p: 'v0', stream_1080p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
            });
            expect(ordered.map(label)).toEqual([
                'v0_0.m4s stream_720p 0',
                'v0_0.m4s stream_720p 1',
                'v0_0.m4s stream_1080p 0',
                'v0_0.m4s stream_1080p 1',
                'v0_1.m4s stream_720p 2',
                'v0_1.m4s stream_720p 3',
                'v0_1.m4s stream_1080p 2',
                'v0_1.m4s stream_1080p 3',
                'v0_1.m4s stream_720p 4',
                'v0_1.m4s stream_720p 5',
                'v0_1.m4s stream_1080p 4',
                'v0_1.m4s stream_1080p 5',
                'v0_1.m4s stream_720p 6',
                'v0_1.m4s stream_1080p 6',
            ]);
        });

        it('applies to the audio chain too', async () => {
            seedTagged('stream_en', sizesOf(4));
            seedTagged('stream_fr', sizesOf(4, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_en: 'a', stream_fr: 'a' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
            });
            expect(ordered.map(label)).toEqual([
                'a_0.m4s stream_en 0',
                'a_0.m4s stream_en 1',
                'a_0.m4s stream_fr 0',
                'a_0.m4s stream_fr 1',
                'a_1.m4s stream_en 2',
                'a_1.m4s stream_en 3',
                'a_1.m4s stream_fr 2',
                'a_1.m4s stream_fr 3',
            ]);
        });

        it('holds a block open for a stream that lags, while later blocks collect', async () => {
            seedTagged('stream_1080p', sizesOf(7));
            const slow = seedTagged('stream_720p', sizesOf(7, 60), {
                present: 1,
            });
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            // 720p has not finished block 0, so nothing is written at all.
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'media'))).toBe(false);
            expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                true
            );

            // Through block 1: blocks 0 and 1 go out, block 2 waits on 720p.
            slow.more(4);
            await (pipeline as any).poll();
            await vi.waitFor(() =>
                expect(uploads.has('prefix/media/v0_0.m4s')).toBe(true)
            );
            expect(existsSync(join(tmpDir, 'stream_1080p', name(3)))).toBe(
                false
            );
            expect(existsSync(join(tmpDir, 'stream_1080p', name(4)))).toBe(
                true
            );

            // One segment short of the end of block 2: still held.
            slow.more(5);
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'stream_1080p', name(4)))).toBe(
                true
            );

            // Through block 2: it goes out, block 3 waits.
            slow.more(6);
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'stream_1080p', name(4)))).toBe(
                false
            );
            expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                true
            );

            slow.more(7);
            await pipeline.drain();

            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
        });

        it('keeps the first chunk to its ~20 s, grouped, and grows the next one to the cap', async () => {
            // Six-second segments: block 0 is ceil(20 / 6) = 4 per stream, and
            // a 60 s block is 10.
            seedTagged('stream_1080p', sizesOf(15));
            seedTagged('stream_720p', sizesOf(15, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 6,
                byteRangeBlockSeconds: 60,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 4,
                perBlock: 10,
            });
            expect(
                ordered.filter((p) => p.chunk === 'v0_0.m4s').map(label)
            ).toEqual([
                'v0_0.m4s stream_1080p 0',
                'v0_0.m4s stream_1080p 1',
                'v0_0.m4s stream_1080p 2',
                'v0_0.m4s stream_1080p 3',
                'v0_0.m4s stream_720p 0',
                'v0_0.m4s stream_720p 1',
                'v0_0.m4s stream_720p 2',
                'v0_0.m4s stream_720p 3',
            ]);
            expect([...uploads.keys()].sort()).toEqual([
                'prefix/media/v0_0.m4s',
                'prefix/media/v0_1.m4s',
            ]);
        });

        it('closes a chunk before a block that would pass the cap, never inside it', async () => {
            // 40-byte segments, so a block of two streams is 160 bytes. Under a
            // 380-byte cap chunk 1 takes blocks 1 and 2 (320 bytes). Block 3
            // (80) would pass the cap, though its first segment alone would
            // not, so it starts chunk 2 whole.
            seedTagged('stream_1080p', Array(7).fill(40));
            seedTagged('stream_720p', Array(7).fill(40));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                byteRangeMaxFileSizeBytes: 380,
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
            expect([...uploads].map(([k, v]) => [k, v.length]).sort()).toEqual([
                ['prefix/media/v0_0.m4s', 160],
                ['prefix/media/v0_1.m4s', 320],
                ['prefix/media/v0_2.m4s', 80],
            ]);
        });

        it('splits a block bigger than the cap on its own at segment boundaries, and says so', async () => {
            const warn = vi
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => {});
            seedTagged('stream_1080p', Array(4).fill(40));
            seedTagged('stream_720p', Array(4).fill(40));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                byteRangeMaxFileSizeBytes: 100,
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
                splitBlocks: true,
            });
            for (const chunk of uploads.values()) {
                expect(chunk.length).toBeLessThanOrEqual(100);
            }
            expect(
                warn.mock.calls.some((c) =>
                    String(c[0]).includes(
                        'over the 100-byte chunk cap — splitting it across chunks'
                    )
                )
            ).toBe(true);
        });

        it('writes a partial last block at the drain, streams of uneven length included', async () => {
            seedTagged('stream_1080p', sizesOf(5));
            seedTagged('stream_720p', sizesOf(4, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            // Block 2 holds only 1080p's last segment, and nothing passes it.
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'stream_1080p', name(4)))).toBe(
                true
            );

            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
            });
            expect(ordered.at(-1)).toEqual(
                expect.objectContaining({ stream: 'stream_1080p', position: 4 })
            );
        });

        it('blocks a quick trim by position, whatever its parts are numbered', async () => {
            const files = [
                'segment_0000000.m4s',
                'segment_0100000.m4s',
                'segment_0100001.m4s',
                'segment_0200000.m4s',
            ];
            seedTagged('stream_1080p', sizesOf(4), { files });
            seedTagged('stream_720p', sizesOf(4, 60), { files });
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            // Every segment is there before the pipeline starts, as after a quick trim.
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
            });
            expect(ordered.map(label)).toEqual([
                'v0_0.m4s stream_1080p 0',
                'v0_0.m4s stream_1080p 1',
                'v0_0.m4s stream_720p 0',
                'v0_0.m4s stream_720p 1',
                'v0_1.m4s stream_1080p 2',
                'v0_1.m4s stream_1080p 3',
                'v0_1.m4s stream_720p 2',
                'v0_1.m4s stream_720p 3',
            ]);
        });

        it('rounds a block length that does not divide by the segment duration up to whole segments', async () => {
            // 25 s over 10 s segments: three per block after block 0's two.
            seedTagged('stream_1080p', sizesOf(8));
            seedTagged('stream_720p', sizesOf(8, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 25,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 3,
            });
            expect(ordered.slice(4, 10).map(label)).toEqual([
                'v0_1.m4s stream_1080p 2',
                'v0_1.m4s stream_1080p 3',
                'v0_1.m4s stream_1080p 4',
                'v0_1.m4s stream_720p 2',
                'v0_1.m4s stream_720p 3',
                'v0_1.m4s stream_720p 4',
            ]);
        });

        it('packs encrypted segments as encrypted, and leaves the inits outside the chunks', async () => {
            seedTagged('stream_1080p', sizesOf(5));
            seedTagged('stream_720p', sizesOf(5, 60));
            for (const stream of ['stream_1080p', 'stream_720p']) {
                writeFileSync(
                    join(tmpDir, stream, 'init.mp4'),
                    `INIT ${stream}`
                );
            }
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
                encryptionKey: Buffer.alloc(16, 1),
                encryptionIV: Buffer.alloc(16, 2),
            });
            // Ciphertext is longer than the plaintext, as AES-CBC padding makes it.
            (pipeline as any).encryptionService = {
                encryptSegment: vi.fn(async (path: string) => {
                    const encrypted = Buffer.concat([
                        Buffer.from('ENC|'),
                        readFileSync(path),
                        Buffer.alloc(7, '!'),
                    ]);
                    writeFileSync(path, encrypted);
                    const [stream, file] = path.split(/[\\/]/).slice(-2);
                    originals.set(`${stream}/${file}`, encrypted);
                }),
            };
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await pipeline.drain();

            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
            expect(
                (pipeline as any).encryptionService.encryptSegment
            ).toHaveBeenCalledTimes(10);
            for (const [key, chunk] of uploads) {
                expect(key).toMatch(/^prefix\/media\/v0_\d+\.m4s$/);
                expect(chunk.includes('INIT')).toBe(false);
            }
            for (const stream of ['stream_1080p', 'stream_720p']) {
                expect(
                    readFileSync(join(tmpDir, stream, 'init.mp4'), 'utf-8')
                ).toBe(`INIT ${stream}`);
            }
        });

        it('closes the first chunk on block 0 of the streams that have started, not of every mapped one', async () => {
            // A ladder in waves: five renditions map to v0, three produce now.
            const streamChains = Object.fromEntries(
                ['1080p', '720p', '480p', '360p', '240p'].map((r) => [
                    `stream_${r}`,
                    'v0',
                ])
            );
            seedTagged('stream_1080p', sizesOf(15));
            seedTagged('stream_720p', sizesOf(15, 60));
            seedTagged('stream_480p', sizesOf(15, 80));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains,
                segmentDurationSeconds: 6,
                byteRangeBlockSeconds: 60,
            });
            const uploads = captureUploads(pipeline);

            // Out mid-encode, without waiting on the two that have not started.
            await (pipeline as any).poll();
            await vi.waitFor(() =>
                expect(uploads.has('prefix/media/v0_0.m4s')).toBe(true)
            );
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 4,
                perBlock: 10,
            });
            const first = ordered.filter((p) => p.chunk === 'v0_0.m4s');
            expect(first).toHaveLength(12);
            expect(first.every((p) => p.position < 4)).toBe(true);
        });

        it('writes block 0 of a stream that starts while the others are part-way, once it has passed it', async () => {
            seedTagged('stream_1080p', sizesOf(7));
            seedTagged('stream_720p', sizesOf(7, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: {
                    stream_1080p: 'v0',
                    stream_720p: 'v0',
                    stream_480p: 'v0',
                },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            // Blocks 0 to 2 go out; block 3 waits on more of either stream.
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                true
            );

            // 480p's block 0 is behind block 3 in time but ready first.
            seedTagged('stream_480p', sizesOf(2, 80));
            await (pipeline as any).poll();
            expect(existsSync(join(tmpDir, 'stream_480p', name(1)))).toBe(
                false
            );
            expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                true
            );

            await pipeline.drain();
            expect(
                placements()
                    .sort(
                        (a, b) =>
                            chunkNumber(a.chunk) - chunkNumber(b.chunk) ||
                            a.offset - b.offset
                    )
                    .map(label)
            ).toEqual([
                'v0_0.m4s stream_1080p 0',
                'v0_0.m4s stream_1080p 1',
                'v0_0.m4s stream_720p 0',
                'v0_0.m4s stream_720p 1',
                'v0_1.m4s stream_1080p 2',
                'v0_1.m4s stream_1080p 3',
                'v0_1.m4s stream_720p 2',
                'v0_1.m4s stream_720p 3',
                'v0_1.m4s stream_1080p 4',
                'v0_1.m4s stream_1080p 5',
                'v0_1.m4s stream_720p 4',
                'v0_1.m4s stream_720p 5',
                'v0_1.m4s stream_480p 0',
                'v0_1.m4s stream_480p 1',
                'v0_1.m4s stream_1080p 6',
                'v0_1.m4s stream_720p 6',
            ]);
        });

        it('holds every later block of a chain behind a stream that ended early, until the drain', async () => {
            // A short audio track: nothing tells the pipeline it has ended.
            seedTagged('stream_en', sizesOf(10));
            seedTagged('stream_fr', sizesOf(2, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_en: 'a', stream_fr: 'a' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            await vi.waitFor(() =>
                expect(uploads.has('prefix/media/a_0.m4s')).toBe(true)
            );
            for (let i = 2; i < 10; i++) {
                expect(existsSync(join(tmpDir, 'stream_en', name(i)))).toBe(
                    true
                );
            }

            await pipeline.drain();
            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
        });

        it("keeps each chain's blocks to its own streams, so a lagging chain holds back no other", async () => {
            // Two angles and the audio chain in one encode, as every multi-angle video is.
            const streamChains: Record<string, string> = {
                stream_a0_hi: 'v0',
                stream_a0_lo: 'v0',
                stream_a1_hi: 'v1',
                stream_a1_lo: 'v1',
                stream_en: 'a',
                stream_fr: 'a',
            };
            seedTagged('stream_a0_hi', sizesOf(7));
            seedTagged('stream_a0_lo', sizesOf(7, 60));
            const a1hi = seedTagged('stream_a1_hi', sizesOf(7, 80), {
                present: 3,
            });
            const a1lo = seedTagged('stream_a1_lo', sizesOf(7, 100), {
                present: 3,
            });
            const en = seedTagged('stream_en', sizesOf(6, 120), { present: 3 });
            // A short track: it ends after three segments.
            const fr = seedTagged('stream_fr', sizesOf(3, 140), { present: 1 });
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains,
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);
            const onDisk = (stream: string, i: number) =>
                existsSync(join(tmpDir, stream, name(i)));

            // Angle 0 has passed block 2 and angle 1 block 0, mid-encode, while
            // audio waits on fr's block 0.
            await (pipeline as any).poll();
            await vi.waitFor(() => {
                expect(uploads.has('prefix/media/v0_0.m4s')).toBe(true);
                expect(uploads.has('prefix/media/v1_0.m4s')).toBe(true);
            });
            for (const stream of ['stream_a0_hi', 'stream_a0_lo']) {
                expect(onDisk(stream, 5)).toBe(false);
                expect(onDisk(stream, 6)).toBe(true);
            }
            for (const stream of ['stream_a1_hi', 'stream_a1_lo']) {
                expect(onDisk(stream, 1)).toBe(false);
                expect(onDisk(stream, 2)).toBe(true);
            }
            expect(onDisk('stream_en', 0)).toBe(true);
            expect(onDisk('stream_fr', 0)).toBe(true);
            expect(uploads.has('prefix/media/a_0.m4s')).toBe(false);

            // Angle 1 catches up through block 2 and audio's block 0 goes out,
            // while fr still holds audio's block 1 and angle 0 waits for block 3.
            a1hi.more(6);
            a1lo.more(6);
            en.more(6);
            fr.more(3);
            await (pipeline as any).poll();
            await vi.waitFor(() =>
                expect(uploads.has('prefix/media/a_0.m4s')).toBe(true)
            );
            for (const stream of ['stream_a1_hi', 'stream_a1_lo']) {
                expect(onDisk(stream, 5)).toBe(false);
            }
            expect(onDisk('stream_en', 1)).toBe(false);
            expect(onDisk('stream_en', 2)).toBe(true);
            expect(onDisk('stream_fr', 2)).toBe(true);
            expect(onDisk('stream_a0_hi', 6)).toBe(true);

            a1hi.more(7);
            a1lo.more(7);
            await pipeline.drain();

            const ordered = verifyBlockLayout(uploads, {
                lead: 2,
                perBlock: 2,
            });
            for (const p of ordered) {
                expect(chainOf(p.chunk), label(p)).toBe(streamChains[p.stream]);
            }
        });

        it('stops writing mid-block on an abort, and salvages only what reached the chunk', async () => {
            seedTagged('stream_1080p', sizesOf(4));
            seedTagged('stream_720p', sizesOf(4, 60));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            captureUploads(pipeline);
            // Abort once 1080p's half of block 1 is in chunk 1.
            const writeSegment = (pipeline as any).writeSegment.bind(pipeline);
            let written = 0;
            vi.spyOn(pipeline as any, 'writeSegment').mockImplementation(
                async (...args: unknown[]) => {
                    await writeSegment(...args);
                    if (++written === 6) pipeline.abort();
                }
            );

            await (pipeline as any).poll();
            const kept = await pipeline.salvage();

            expect(written).toBe(6);
            expect(kept).toHaveLength(1);
            expect(kept[0].objectKey).toBe('prefix/media/v0_1.m4s');
            expect(
                kept[0].segments.map((s) => `${s.stream} ${s.index}`)
            ).toEqual(['stream_1080p 2', 'stream_1080p 3']);
            expect(readFileSync(kept[0].filePath)).toEqual(
                Buffer.concat([
                    originals.get(`stream_1080p/${name(2)}`)!,
                    originals.get(`stream_1080p/${name(3)}`)!,
                ])
            );
            // 720p's half was never written, so it is still where ffmpeg put it.
            expect(existsSync(join(tmpDir, 'stream_720p', name(2)))).toBe(true);
            expect(existsSync(join(tmpDir, 'stream_720p', name(3)))).toBe(true);
        });

        it("sweeps up a finished wave's last segment, written after the last poll", async () => {
            const { more } = seedTagged('stream_1080p', sizesOf(7), {
                present: 6,
            });
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
            });
            const uploads = captureUploads(pipeline);

            await (pipeline as any).poll();
            more(7);
            await pipeline.finishStreams(['stream_1080p']);

            // In the open chunk at once, not held for the drain.
            expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                false
            );
            await pipeline.drain();
            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
        });

        it('waits for a poll in flight, so two writers never share a chunk', async () => {
            seedTagged('stream_1080p', sizesOf(7));
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
                pollIntervalMs: 5,
            });
            const uploads = captureUploads(pipeline);
            const writeSegment = (pipeline as any).writeSegment.bind(pipeline);
            let finishing: Promise<void> | undefined;
            let calledMidPoll = false;
            let writing = 0;
            let overlapped = false;
            vi.spyOn(pipeline as any, 'writeSegment').mockImplementation(
                async (...args: unknown[]) => {
                    // The wave ends while the timer's poll is writing block 0.
                    if (!finishing) {
                        calledMidPoll = (pipeline as any).polling;
                        finishing = pipeline.finishStreams(['stream_1080p']);
                    }
                    if (writing++ > 0) overlapped = true;
                    try {
                        await new Promise((r) => setTimeout(r, 20));
                        await writeSegment(...args);
                    } finally {
                        writing--;
                    }
                }
            );

            pipeline.start();
            await vi.waitFor(() => expect(finishing).toBeDefined());
            await finishing;
            await pipeline.drain();

            expect(calledMidPoll).toBe(true);
            expect(overlapped).toBe(false);
            expect(pipeline.error).toBeNull();
            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
        });

        it("keeps the timer's poll out while its own sweep is writing", async () => {
            seedTagged('stream_1080p', sizesOf(7));
            const { more } = seedTagged('stream_720p', sizesOf(7, 60), {
                present: 2,
            });
            const pipeline = makePipeline(tmpDir, {
                byteRange: true,
                streamChains: { stream_1080p: 'v0', stream_720p: 'v0' },
                segmentDurationSeconds: 10,
                byteRangeBlockSeconds: 20,
                pollIntervalMs: 5,
            });
            const uploads = captureUploads(pipeline);
            const writeSegment = (pipeline as any).writeSegment.bind(pipeline);
            let writing = 0;
            let overlapped = false;
            vi.spyOn(pipeline as any, 'writeSegment').mockImplementation(
                async (...args: unknown[]) => {
                    // The rest of 720p lands while the sweep writes block 0,
                    // with the timer due several times before it is done.
                    more(7);
                    if (writing++ > 0) overlapped = true;
                    try {
                        await new Promise((r) => setTimeout(r, 20));
                        await writeSegment(...args);
                    } finally {
                        writing--;
                    }
                }
            );

            pipeline.start();
            await pipeline.finishStreams(['stream_1080p']);
            await pipeline.drain();

            expect(overlapped).toBe(false);
            expect(pipeline.error).toBeNull();
            verifyBlockLayout(uploads, { lead: 2, perBlock: 2 });
        });

        describe('an interrupted encode, continued', () => {
            const box = (type: string, ...content: Buffer[]) => {
                const body = Buffer.concat(content);
                const head = Buffer.alloc(8);
                head.writeUInt32BE(body.length + 8, 0);
                head.write(type, 4, 4, 'latin1');
                return Buffer.concat([head, body]);
            };
            /** A segment starting at `tfdt`, padded so each stream's are a size of their own. */
            const fmp4Segment = (tfdt: number, pad: number) => {
                const tfdtBox = Buffer.alloc(12);
                tfdtBox.writeUInt8(1, 0);
                tfdtBox.writeBigUInt64BE(BigInt(tfdt), 4);
                return Buffer.concat([
                    box('styp', Buffer.from('msdh', 'latin1')),
                    box('moof', box('traf', box('tfdt', tfdtBox))),
                    box('mdat', Buffer.alloc(pad)),
                ]);
            };
            const init = () => {
                const mdhd = Buffer.alloc(24);
                mdhd.writeUInt32BE(90000, 12);
                return box(
                    'moov',
                    box(
                        'trak',
                        box(
                            'mdia',
                            box('mdhd', mdhd),
                            box(
                                'minf',
                                box('stbl', box('stsd', Buffer.from('avc1')))
                            )
                        )
                    )
                );
            };
            const TEN_SECONDS = 900000;
            const pads: Record<string, number> = {
                stream_1080p: 32,
                stream_720p: 16,
            };
            const streamChains = { stream_1080p: 'v0', stream_720p: 'v0' };

            /** Segments `from`..`to`-1 of a stream, timed from `tfdtBase` as a fresh ffmpeg times them. */
            function seedRun(
                stream: string,
                from: number,
                to: number,
                tfdtBase: number
            ): void {
                const dir = join(tmpDir, stream);
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'init.mp4'), init());
                const lines = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-TARGETDURATION:10',
                    `#EXT-X-MEDIA-SEQUENCE:${from}`,
                    '#EXT-X-PLAYLIST-TYPE:VOD',
                    '#EXT-X-INDEPENDENT-SEGMENTS',
                    '#EXT-X-MAP:URI="init.mp4"',
                ];
                for (let i = from; i < to; i++) {
                    writeFileSync(
                        join(dir, name(i)),
                        fmp4Segment(
                            tfdtBase + (i - from) * TEN_SECONDS,
                            pads[stream]
                        )
                    );
                    lines.push('#EXTINF:10.000000,', name(i));
                }
                lines.push('#EXT-X-ENDLIST', '');
                writeFileSync(join(dir, 'playlist.m3u8'), lines.join('\n'));
            }

            /** What a continue reads back: every start time seen, and what is stored. */
            const recordsOf = (
                seen: DurableSegment[],
                stored: DurableSegment[]
            ): ResumeRecord[] => [
                ...seen.map((s) => ({
                    kind: 'seen' as const,
                    stream: s.stream,
                    index: s.index,
                    tfdt: s.tfdt!,
                })),
                ...stored.map((s) => ({ kind: 'durable' as const, ...s })),
            ];

            it("stores whole blocks, keeps none of what was still held, and counts the continued run's blocks from its restart", async () => {
                // The first run: 1080p is through segment 4, 720p through 3. Blocks
                // 0 and 1 are complete; block 2 is held for 720p.
                seedRun('stream_1080p', 0, 5, 0);
                seedRun('stream_720p', 0, 4, 0);
                const durable: DurableSegment[] = [];
                const seen: DurableSegment[] = [];
                const first = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains,
                    segmentDurationSeconds: 10,
                    byteRangeBlockSeconds: 20,
                    onDurable: (segments) => durable.push(...segments),
                    onSegment: (segment) => seen.push(segment),
                });
                captureUploads(first);

                await (first as any).poll();
                await vi.waitFor(() => expect(durable).toHaveLength(4));
                first.abort();
                const kept = await first.salvage();

                // Chunk 0, block 0, reached storage.
                expect(durable.map((d) => `${d.stream} ${d.index}`)).toEqual([
                    'stream_1080p 0',
                    'stream_1080p 1',
                    'stream_720p 0',
                    'stream_720p 1',
                ]);
                // The open chunk holds block 1, whole and grouped; segment 4,
                // still held, is in neither.
                expect(kept).toHaveLength(1);
                expect(kept[0].objectKey).toBe('prefix/media/v0_1.m4s');
                expect(
                    kept[0].segments.map(
                        (s) => `${s.stream} ${s.index} @${s.offset}`
                    )
                ).toEqual([
                    'stream_1080p 2 @0',
                    'stream_1080p 3 @88',
                    'stream_720p 2 @176',
                    'stream_720p 3 @248',
                ]);
                expect(readFileSync(kept[0].filePath).length).toBe(
                    kept[0].size
                );

                // Segment 4's start is unknown in 720p, so the continue
                // restarts at 3, inside what was block 1.
                const point = resumePoint(
                    Object.keys(streamChains),
                    recordsOf(seen, [...durable, ...kept[0].segments])
                )!;
                expect(point.startIndex).toBe(3);

                rmSync(tmpDir, { recursive: true, force: true });
                seedRun('stream_1080p', 3, 7, 0);
                seedRun('stream_720p', 3, 7, 0);
                const continued: DurableSegment[] = [];
                const second = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains,
                    segmentDurationSeconds: 10,
                    byteRangeBlockSeconds: 20,
                    attempt: 1,
                    resume: {
                        ...point,
                        previousInits: {
                            stream_1080p: init(),
                            stream_720p: init(),
                        },
                    },
                    onDurable: (segments) => continued.push(...segments),
                });
                const uploads = captureUploads(second);

                await second.drain();

                // The continued run's first chunk is its own block 0: ~20 s.
                expect(
                    continued.map(
                        (d) => `${d.mediaFile} ${d.stream} ${d.index} ${d.tfdt}`
                    )
                ).toEqual([
                    `media/v0_r1_0.m4s stream_1080p 3 ${3 * TEN_SECONDS}`,
                    `media/v0_r1_0.m4s stream_1080p 4 ${4 * TEN_SECONDS}`,
                    `media/v0_r1_0.m4s stream_720p 3 ${3 * TEN_SECONDS}`,
                    `media/v0_r1_0.m4s stream_720p 4 ${4 * TEN_SECONDS}`,
                    `media/v0_r1_1.m4s stream_1080p 5 ${5 * TEN_SECONDS}`,
                    `media/v0_r1_1.m4s stream_1080p 6 ${6 * TEN_SECONDS}`,
                    `media/v0_r1_1.m4s stream_720p 5 ${5 * TEN_SECONDS}`,
                    `media/v0_r1_1.m4s stream_720p 6 ${6 * TEN_SECONDS}`,
                ]);
                for (const stream of Object.keys(streamChains)) {
                    const lines = readPlaylist(stream);
                    const uris = lines.filter((l) => l && !l.startsWith('#'));
                    expect(uris).toEqual([
                        '../media/v0_0.m4s',
                        '../media/v0_0.m4s',
                        '../media/v0_1.m4s',
                        '../media/v0_r1_0.m4s',
                        '../media/v0_r1_0.m4s',
                        '../media/v0_r1_1.m4s',
                        '../media/v0_r1_1.m4s',
                    ]);
                    // This run's ranges hold this stream's segments, in order.
                    const ranges = lines.filter((l) =>
                        l.startsWith('#EXT-X-BYTERANGE:')
                    );
                    uris.forEach((uri, index) => {
                        if (!uri.includes('_r1_')) return;
                        const [length, offset] = ranges[index]
                            .slice('#EXT-X-BYTERANGE:'.length)
                            .split('@')
                            .map(Number);
                        const bytes = uploads
                            .get(`prefix/${uri.slice('../'.length)}`)!
                            .subarray(offset, offset + length);
                        expect(bytes.length).toBe(56 + pads[stream]);
                        expect(readBaseMediaDecodeTime(bytes)).toBe(
                            index * TEN_SECONDS
                        );
                    });
                }
            });

            /**
             * A ladder in waves: 1080p is wave 0 and finishes, then 720p
             * starts in the same chain and the run fails part-way through it.
             */
            it.each([
                ['arrival order', 0],
                ['blocks', 20],
            ])(
                'keeps a finished wave whole for a continue to skip, in %s',
                async (_order, blockSeconds) => {
                    const waves = [
                        { videoStreams: ['stream_1080p'], audioStreams: [] },
                        { videoStreams: ['stream_720p'], audioStreams: [] },
                    ];
                    const durable: DurableSegment[] = [];
                    const seen: DurableSegment[] = [];
                    const pipeline = makePipeline(tmpDir, {
                        byteRange: true,
                        streamChains,
                        segmentDurationSeconds: 10,
                        byteRangeBlockSeconds: blockSeconds,
                        onDurable: (segments) => durable.push(...segments),
                        onSegment: (segment) => seen.push(segment),
                    });
                    captureUploads(pipeline);

                    seedRun('stream_1080p', 0, 7, 0);
                    await (pipeline as any).poll();
                    // Its last segment is written only when the wave ends.
                    await pipeline.finishStreams(['stream_1080p']);
                    seedRun('stream_720p', 0, 3, 0);
                    await (pipeline as any).poll();
                    await vi.waitFor(() =>
                        expect(durable.length).toBeGreaterThan(0)
                    );
                    pipeline.abort();
                    await pipeline.settle();
                    const kept = await pipeline.salvage();

                    const stored = [
                        ...durable,
                        ...kept.flatMap((k) => k.segments),
                    ];
                    const indices = (stream: string) =>
                        stored
                            .filter((s) => s.stream === stream)
                            .map((s) => s.index)
                            .sort((a, b) => a - b);
                    expect(indices('stream_1080p')).toEqual([
                        0, 1, 2, 3, 4, 5, 6,
                    ]);
                    expect(indices('stream_720p').slice(0, 2)).toEqual([0, 1]);

                    const plan = resumePlan(waves, [
                        ...recordsOf(seen, stored),
                        {
                            kind: 'waveDone',
                            wave: 0,
                            counts: { stream_1080p: 7 },
                        },
                    ])!;
                    expect(plan.skip).toBe(1);
                    expect(Object.keys(plan.point!.startTfdt)).toEqual([
                        'stream_720p',
                    ]);
                    expect(plan.point!.startIndex).toBeGreaterThanOrEqual(2);
                }
            );

            it("writes a finished wave's last partial block into the open chunk, and the next wave's blocks after it", async () => {
                const pipeline = makePipeline(tmpDir, {
                    byteRange: true,
                    streamChains,
                    segmentDurationSeconds: 10,
                    byteRangeBlockSeconds: 20,
                });
                captureUploads(pipeline);

                seedRun('stream_1080p', 0, 7, 0);
                await (pipeline as any).poll();
                expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                    true
                );
                await pipeline.finishStreams(['stream_1080p']);
                expect(existsSync(join(tmpDir, 'stream_1080p', name(6)))).toBe(
                    false
                );

                seedRun('stream_720p', 0, 3, 0);
                await (pipeline as any).poll();
                pipeline.abort();
                const kept = await pipeline.salvage();

                expect(kept).toHaveLength(1);
                expect(
                    kept[0].segments.map((s) => `${s.stream} ${s.index}`)
                ).toEqual([
                    'stream_1080p 2',
                    'stream_1080p 3',
                    'stream_1080p 4',
                    'stream_1080p 5',
                    'stream_1080p 6',
                    'stream_720p 0',
                    'stream_720p 1',
                ]);
                // 720p's segment 2 is still held for its block.
                expect(existsSync(join(tmpDir, 'stream_720p', name(2)))).toBe(
                    true
                );
            });
        });
    });
});

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

        it('skips them on Windows too, where paths use backslashes', async () => {
            // `concat.txt` lists the encoder's local file paths, so on Windows it
            // put those in the bucket beside the video.
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n');
            const pipeline = makePipeline(tmpDir);
            vi.spyOn(pipeline as any, 'walkDir').mockResolvedValue([
                join(tmpDir, 'master.m3u8'),
                `${tmpDir}\\concat.txt`,
                `${tmpDir}\\thumbnails\\pack-list.txt`,
            ]);

            const keys = await pipeline.uploadRemainingFiles(tmpDir);

            expect(keys).toEqual(['prefix/master.m3u8']);
            expect(sentKeys(pipeline)).toEqual(['prefix/master.m3u8']);
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
         *
         * Bounded by wall-clock time, not by a count of turns: how many turns
         * that I/O takes depends on the machine, and a loop that stops
         * advancing before the work settles leaves the backoff on a faked
         * timer nothing will ever fire.
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
            // `Date` is real: only `setTimeout` is faked.
            const deadline = Date.now() + 4000;
            while (!done && Date.now() < deadline) {
                await new Promise((r) => setImmediate(r));
                await vi.advanceTimersByTimeAsync(2000);
            }
            if (!done) throw new Error('upload did not settle within 4s');
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
