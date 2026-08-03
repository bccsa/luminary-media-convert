import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReadableStream } from 'stream/web';

const { mockLookup, mockInFlightShortfall } = vi.hoisted(() => ({
    mockLookup: vi.fn(),
    // Null by default — the guard stays out of the way of every test that is
    // not about it.
    mockInFlightShortfall: vi.fn().mockResolvedValue(null),
}));

vi.mock('dns/promises', () => ({
    lookup: (...args: any[]) => mockLookup(...args),
}));

// Only the in-flight guard is stubbed; `ingestShortfall` stays real so the
// check before the download is still exercised by the tests above it. Free
// space cannot be made to fall mid-download from a test, and the wiring — that
// a refusal actually aborts the transfer — is what these cover.
vi.mock('./disk-space.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./disk-space.js')>()),
    inFlightShortfall: (...args: any[]) => mockInFlightShortfall(...args),
}));

import { UrlFetchService } from './url-fetch.service.js';
import { SessionService } from './session.service.js';
import { TusUploadService } from './tus-upload.service.js';
import { WebhookService } from './webhook.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(opts: { withWebhook?: boolean } = {}): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
        ...(opts.withWebhook
            ? { webhook: { url: 'https://example.com/webhook', sessionToken: 'tok' } }
            : {}),
    };
}

function streamFromBuffer(buf: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(buf);
            controller.close();
        },
    });
}

function makeResponse(opts: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    url?: string;
    body?: Buffer | null;
}): Response {
    const status = opts.status ?? 200;
    const headers = new Headers(opts.headers ?? {});
    const body = opts.body ? streamFromBuffer(opts.body) : null;
    const res = new Response(body as any, {
        status,
        statusText: opts.statusText ?? '',
        headers,
    });
    if (opts.url !== undefined) {
        Object.defineProperty(res, 'url', { value: opts.url });
    }
    return res;
}

describe('UrlFetchService', () => {
    let workDir: string;
    let sessionService: SessionService;
    let tusUploadService: { finalizeUpload: ReturnType<typeof vi.fn> };
    let webhookService: { send: ReturnType<typeof vi.fn> };
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'url-fetch-test-'));
        process.env.WORK_DIR = workDir;
        delete process.env.URL_FETCH_STREAMS;
        delete process.env.MAX_UPLOAD_SIZE;
        delete process.env.DISK_RESERVE_BYTES;
        mockInFlightShortfall.mockResolvedValue(null);

        sessionService = new SessionService({ emit: () => {} } as any);
        tusUploadService = { finalizeUpload: vi.fn().mockResolvedValue(undefined) };
        webhookService = { send: vi.fn().mockResolvedValue(undefined) };

        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        mockLookup.mockReset();
        mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        try {
            rmSync(workDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        delete process.env.WORK_DIR;
        delete process.env.URL_FETCH_STREAMS;
        delete process.env.MAX_UPLOAD_SIZE;
        delete process.env.DISK_RESERVE_BYTES;
    });

    function makeService(): UrlFetchService {
        return new UrlFetchService(
            sessionService,
            tusUploadService as unknown as TusUploadService,
            webhookService as unknown as WebhookService,
        );
    }

    describe('constructor / configuration', () => {
        it('uses default URL_FETCH_STREAMS when env var is absent', () => {
            const svc = makeService();
            expect((svc as any).streams).toBe(4);
        });

        it('clamps URL_FETCH_STREAMS to [1, 16]', () => {
            process.env.URL_FETCH_STREAMS = '0';
            expect((makeService() as any).streams).toBe(1);

            process.env.URL_FETCH_STREAMS = '99';
            expect((makeService() as any).streams).toBe(16);

            process.env.URL_FETCH_STREAMS = 'not a number';
            expect((makeService() as any).streams).toBe(4);

            process.env.URL_FETCH_STREAMS = '8';
            expect((makeService() as any).streams).toBe(8);
        });

        it('honors MAX_UPLOAD_SIZE env var', () => {
            process.env.MAX_UPLOAD_SIZE = '12345';
            expect((makeService() as any).maxSize).toBe(12345);
        });
    });

    describe('abort', () => {
        it('returns false when no fetch is in flight', () => {
            const svc = makeService();
            expect(svc.abort('nonexistent')).toBe(false);
        });

        it('aborts the in-flight controller and returns true', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            // Hang fetch until the AbortSignal fires, then reject like real fetch.
            // Also reject synchronously if the signal is already aborted on entry —
            // the probe step falls through to a ranged GET on the first failure,
            // and that second fetch must not re-hang.
            const aborted = vi.fn();
            fetchMock.mockImplementation((_url: string, init: any) => {
                if (init?.signal?.aborted) {
                    return Promise.reject(
                        new DOMException('The operation was aborted.', 'AbortError'),
                    );
                }
                return new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        aborted();
                        reject(
                            new DOMException('The operation was aborted.', 'AbortError'),
                        );
                    });
                });
            });

            const fetchPromise = svc.fetchToSession(
                session.id,
                'https://example.com/file.mp4',
            );
            // give the service time to register the controller
            await new Promise((r) => setTimeout(r, 5));

            expect(svc.abort(session.id)).toBe(true);
            expect(aborted).toHaveBeenCalled();

            await fetchPromise;
            expect(sessionService.get(session.id)!.status).toBe('failed');
            // Subsequent abort calls return false (controller removed)
            expect(svc.abort(session.id)).toBe(false);
        });
    });

    describe('URL validation', () => {
        it('rejects non-http(s) protocols', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await svc.fetchToSession(session.id, 'ftp://example.com/file.mp4');

            const s = sessionService.get(session.id)!;
            expect(s.status).toBe('failed');
            expect(s.error).toMatch(/Unsupported URL protocol/);
        });

        it('rejects malformed URLs', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await svc.fetchToSession(session.id, 'not a valid url');

            expect(sessionService.get(session.id)!.status).toBe('failed');
        });

        it('rejects cloud-metadata hostnames', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await svc.fetchToSession(session.id, 'http://169.254.169.254/latest/meta-data');

            const s = sessionService.get(session.id)!;
            expect(s.status).toBe('failed');
            expect(s.error).toMatch(/cloud metadata/);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('rejects when DNS resolves to a blocked address', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());
            mockLookup.mockResolvedValueOnce({ address: '169.254.42.1', family: 4 });

            await svc.fetchToSession(session.id, 'https://internal.example.com/file.mp4');

            const s = sessionService.get(session.id)!;
            expect(s.status).toBe('failed');
            expect(s.error).toMatch(/blocked address/);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('continues when DNS lookup itself fails (lets the fetch surface the error)', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());
            mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
            fetchMock.mockResolvedValue(
                makeResponse({ status: 500, statusText: 'Server Error' }),
            );

            await svc.fetchToSession(session.id, 'https://unresolvable.example/file.mp4');

            const s = sessionService.get(session.id)!;
            expect(s.status).toBe('failed');
            // Failure originates from the probe call (500), not the DNS check.
            expect(s.error).toMatch(/probe URL/);
        });
    });

    describe('probe phase', () => {
        it('uses HEAD when the server supports it', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const body = Buffer.from('hello world');
            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(body.length),
                            'content-type': 'video/mp4',
                            'accept-ranges': 'none',
                        },
                        url: 'https://example.com/video.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/video.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/video.mp4');

            // First call is HEAD
            expect(fetchMock.mock.calls[0]![1].method).toBe('HEAD');
            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'video.mp4'),
            );
            expect(sessionService.get(session.id)!.ingestTotalBytes).toBe(body.length);
        });

        it('falls back to a ranged GET when HEAD fails', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());
            const body = Buffer.from('payload');

            fetchMock
                // HEAD throws → service swallows and tries ranged GET
                .mockRejectedValueOnce(new TypeError('HEAD not supported'))
                // ranged GET probe
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 206,
                        headers: {
                            'content-range': `bytes 0-0/${body.length}`,
                            'content-type': 'video/mp4',
                        },
                        body: Buffer.from('p'),
                        url: 'https://example.com/file.mp4',
                    }),
                )
                // actual download (single stream because body small)
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/file.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/file.mp4');

            expect(fetchMock.mock.calls[1]![1].headers).toEqual({ Range: 'bytes=0-0' });
            expect(tusUploadService.finalizeUpload).toHaveBeenCalled();
            // content-range proved we know length and range support
            expect(sessionService.get(session.id)!.ingestTotalBytes).toBe(body.length);
        });

        it('throws when both HEAD and ranged GET probe fail', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({ status: 405, statusText: 'Method Not Allowed' }),
                )
                .mockResolvedValueOnce(
                    makeResponse({ status: 404, statusText: 'Not Found' }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/missing.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/probe URL/);
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });
    });

    describe('filename derivation', () => {
        async function probe200ThenDownload(
            svc: UrlFetchService,
            sessionId: string,
            opts: {
                contentDisposition?: string;
                contentType?: string;
                url?: string;
                body?: Buffer;
            },
        ) {
            const body = opts.body ?? Buffer.from('data');
            const headers: Record<string, string> = {
                'content-length': String(body.length),
            };
            if (opts.contentDisposition) headers['content-disposition'] = opts.contentDisposition;
            if (opts.contentType) headers['content-type'] = opts.contentType;

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({ status: 200, headers, url: opts.url ?? 'https://example.com/' }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: opts.url ?? 'https://example.com/',
                    }),
                );

            await svc.fetchToSession(sessionId, opts.url ?? 'https://example.com/file.mp4');
        }

        it('uses the suggestedFilename argument when provided', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const body = Buffer.from('data');
            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        url: 'https://example.com/path/opaque',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/path/opaque',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/path/opaque', 'custom.mp4');

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'custom.mp4'),
            );
        });

        it('strips path components from suggestedFilename', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());
            const body = Buffer.from('data');

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        url: 'https://example.com/x',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/x',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/x', '../../etc/evil.mp4');

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'evil.mp4'),
            );
        });

        it('extracts filename from Content-Disposition filename=', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await probe200ThenDownload(svc, session.id, {
                contentDisposition: 'attachment; filename="meeting.mp4"',
                url: 'https://example.com/opaque',
            });

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'meeting.mp4'),
            );
        });

        it('extracts filename from Content-Disposition filename*= (RFC 5987)', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await probe200ThenDownload(svc, session.id, {
                contentDisposition: "attachment; filename*=UTF-8''meeting%20notes.mp4",
                url: 'https://example.com/opaque',
            });

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'meeting notes.mp4'),
            );
        });

        it('falls back to the URL pathname basename', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await probe200ThenDownload(svc, session.id, {
                url: 'https://example.com/path/to/clip.mp4',
            });

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'clip.mp4'),
            );
        });

        it('falls back to input + extension from Content-Type when URL has none', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            await probe200ThenDownload(svc, session.id, {
                url: 'https://drive.example.com/uc?export=download&id=ABC',
                contentType: 'video/mp4',
            });

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'input.mp4'),
            );
        });

        it('rejects when the derived filename has an unsupported extension', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());
            const body = Buffer.from('data');

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(body.length),
                            'content-disposition': 'attachment; filename="nope.exe"',
                        },
                        url: 'https://example.com/x',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/x');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/Unsupported file type/);
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });
    });

    describe('size limits', () => {
        it('rejects when Content-Length exceeds MAX_UPLOAD_SIZE', async () => {
            process.env.MAX_UPLOAD_SIZE = '100';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock.mockResolvedValueOnce(
                makeResponse({
                    status: 200,
                    headers: { 'content-length': '999', 'content-type': 'video/mp4' },
                    url: 'https://example.com/big.mp4',
                }),
            );

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/exceeds the maximum/);
            // Only the probe should have been issued
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('aborts mid-stream when total size is unknown and bytes exceed cap', async () => {
            process.env.MAX_UPLOAD_SIZE = '5';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock
                // probe — no content-length
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-type': 'video/mp4' },
                        url: 'https://example.com/streaming.mp4',
                    }),
                )
                // download body bigger than cap
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {},
                        body: Buffer.from('this exceeds the cap easily'),
                        url: 'https://example.com/streaming.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/streaming.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/maximum allowed size/);
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });
    });

    describe('free space', () => {
        it('refuses a source the disk cannot hold, before downloading it', async () => {
            // A reserve larger than any real volume, so the guard fires whatever
            // the machine running the tests happens to have free.
            process.env.DISK_RESERVE_BYTES = String(1024 ** 5);
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock.mockResolvedValueOnce(
                makeResponse({
                    status: 200,
                    headers: { 'content-length': '999', 'content-type': 'video/mp4' },
                    url: 'https://example.com/big.mp4',
                }),
            );

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(
                /Not enough disk space/,
            );
            // The probe told us it would not fit, so the body was never fetched.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });

        it('stops a single-stream download when the volume runs out under it', async () => {
            // The check before the download only knew what was free then; an
            // encode writing its output beside it can take the rest.
            mockInFlightShortfall.mockResolvedValue(
                'Upload stopped: the encoder is running out of disk space',
            );
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': '11', 'content-type': 'video/mp4' },
                        url: 'https://example.com/small.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {},
                        body: Buffer.from('small video'),
                        url: 'https://example.com/small.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/small.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(
                /Upload stopped/,
            );
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });

        it('stops a parallel download when the volume runs out under it', async () => {
            // The path large sources actually take, which is when disk matters.
            mockInFlightShortfall.mockResolvedValue(
                'Upload stopped: the encoder is running out of disk space',
            );
            process.env.URL_FETCH_STREAMS = '4';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024; // over the 16 MB parallel threshold
            const fullBuf = Buffer.alloc(total);

            fetchMock.mockResolvedValueOnce(
                makeResponse({
                    status: 200,
                    headers: {
                        'content-length': String(total),
                        'content-type': 'video/mp4',
                        'accept-ranges': 'bytes',
                    },
                    url: 'https://cdn.example.com/big.mp4',
                }),
            );
            for (let i = 0; i < 4; i++) {
                fetchMock.mockImplementationOnce(async (_url: string, init: any) => {
                    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)!;
                    const start = parseInt(m[1]!, 10);
                    const end = parseInt(m[2]!, 10);
                    return makeResponse({
                        status: 206,
                        headers: {
                            'content-range': `bytes ${start}-${end}/${total}`,
                            'content-length': String(end - start + 1),
                        },
                        body: fullBuf.subarray(start, end + 1),
                        url: 'https://cdn.example.com/big.mp4',
                    });
                });
            }

            await svc.fetchToSession(session.id, 'https://cdn.example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(
                /Upload stopped/,
            );
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });

        it('downloads normally when the source fits', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': '11', 'content-type': 'video/mp4' },
                        url: 'https://example.com/small.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {},
                        body: Buffer.from('small video'),
                        url: 'https://example.com/small.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/small.mp4');

            expect(sessionService.get(session.id)!.error).toBeUndefined();
            expect(tusUploadService.finalizeUpload).toHaveBeenCalled();
        });
    });

    describe('multi-stream parallel download', () => {
        it('issues N range requests for large range-supporting sources', async () => {
            process.env.URL_FETCH_STREAMS = '4';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024; // 20 MB > 16 MB threshold
            const fullBuf = Buffer.alloc(total);
            for (let i = 0; i < total; i++) fullBuf[i] = i & 0xff;

            // probe (HEAD): range support + total
            fetchMock.mockResolvedValueOnce(
                makeResponse({
                    status: 200,
                    headers: {
                        'content-length': String(total),
                        'content-type': 'video/mp4',
                        'accept-ranges': 'bytes',
                    },
                    url: 'https://cdn.example.com/big.mp4',
                }),
            );

            // 4 range responses
            for (let i = 0; i < 4; i++) {
                fetchMock.mockImplementationOnce(async (_url: string, init: any) => {
                    const range = init.headers.Range as string;
                    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
                    const start = parseInt(m[1]!, 10);
                    const end = parseInt(m[2]!, 10);
                    const chunk = fullBuf.subarray(start, end + 1);
                    return makeResponse({
                        status: 206,
                        headers: {
                            'content-range': `bytes ${start}-${end}/${total}`,
                            'content-length': String(chunk.length),
                        },
                        body: chunk,
                        url: 'https://cdn.example.com/big.mp4',
                    });
                });
            }

            await svc.fetchToSession(session.id, 'https://cdn.example.com/big.mp4');

            // 1 probe + 4 range fetches
            expect(fetchMock).toHaveBeenCalledTimes(5);
            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                session.id,
                join(workDir, session.id, 'big.mp4'),
            );

            // Verify the assembled file matches the source byte-for-byte
            const written = readFileSync(join(workDir, session.id, 'big.mp4'));
            expect(written.equals(fullBuf)).toBe(true);
        });

        it('falls back to single-stream when total is below MIN_PARALLEL_BYTES', async () => {
            process.env.URL_FETCH_STREAMS = '4';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const body = Buffer.from('small file');
            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(body.length),
                            'accept-ranges': 'bytes',
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/small.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/small.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/small.mp4');

            // probe + 1 download (single stream), not 1 + 4
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[1]![1].headers).toBeUndefined();
        });

        it('falls back to single-stream when range support is absent', async () => {
            process.env.URL_FETCH_STREAMS = '4';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024;
            const body = Buffer.alloc(total);

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(total),
                            'accept-ranges': 'none',
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/big.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(total) },
                        body,
                        url: 'https://example.com/big.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(tusUploadService.finalizeUpload).toHaveBeenCalled();
        });

        it('fails when a range response is not 206', async () => {
            process.env.URL_FETCH_STREAMS = '2';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024;
            const halves = Buffer.alloc(total);

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(total),
                            'accept-ranges': 'bytes',
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/big.mp4',
                    }),
                )
                // first range returns the entire body with 200 OK (server ignored Range)
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(total) },
                        body: halves,
                        url: 'https://example.com/big.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 206,
                        headers: {
                            'content-range': `bytes ${total / 2}-${total - 1}/${total}`,
                        },
                        body: halves.subarray(total / 2),
                        url: 'https://example.com/big.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(
                /Expected 206 Partial Content/,
            );
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        });

        it('fails when Content-Range does not match the requested range', async () => {
            process.env.URL_FETCH_STREAMS = '2';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024;
            const buf = Buffer.alloc(total);

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(total),
                            'accept-ranges': 'bytes',
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/big.mp4',
                    }),
                )
                .mockImplementation(async () =>
                    makeResponse({
                        status: 206,
                        headers: { 'content-range': `bytes 0-99/${total}` }, // wrong range
                        body: buf.subarray(0, 100),
                        url: 'https://example.com/big.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/wrong Content-Range/);
        });
    });

    describe('single-stream download', () => {
        it('writes the body to disk and finalizes', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const body = Buffer.from('hello world');
            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(body.length),
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/clip.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': String(body.length) },
                        body,
                        url: 'https://example.com/clip.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/clip.mp4');

            const dest = join(workDir, session.id, 'clip.mp4');
            expect(existsSync(dest)).toBe(true);
            expect(readFileSync(dest).equals(body)).toBe(true);
        });

        it('fails on non-2xx download response', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': '10', 'content-type': 'video/mp4' },
                        url: 'https://example.com/clip.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 500,
                        statusText: 'Internal Server Error',
                        headers: {},
                        body: Buffer.from(''),
                        url: 'https://example.com/clip.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/clip.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/Fetch failed: 500/);
        });
    });

    describe('defensive branches', () => {
        it('fails on download size mismatch (server ships fewer bytes than Content-Range claimed)', async () => {
            process.env.URL_FETCH_STREAMS = '2';
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const total = 20 * 1024 * 1024;

            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: {
                            'content-length': String(total),
                            'accept-ranges': 'bytes',
                            'content-type': 'video/mp4',
                        },
                        url: 'https://example.com/big.mp4',
                    }),
                )
                .mockImplementation(async (_url: string, init: any) => {
                    // Echo a valid Content-Range header for the requested range
                    // but only ship 100 bytes regardless — body terminates early.
                    const range = init.headers.Range as string;
                    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
                    const start = parseInt(m[1]!, 10);
                    const end = parseInt(m[2]!, 10);
                    return makeResponse({
                        status: 206,
                        headers: { 'content-range': `bytes ${start}-${end}/${total}` },
                        body: Buffer.alloc(100),
                        url: 'https://example.com/big.mp4',
                    });
                });

            await svc.fetchToSession(session.id, 'https://example.com/big.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/size mismatch/);
        });

        it('fails when the single-stream download response has no body', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const probeRes = makeResponse({
                status: 200,
                headers: { 'content-length': '10', 'content-type': 'video/mp4' },
                url: 'https://example.com/clip.mp4',
            });
            // A real Response constructed with body=null. Bypass makeResponse since
            // the helper would attach a Buffer.
            const downloadRes = new Response(null, { status: 200 });
            Object.defineProperty(downloadRes, 'url', {
                value: 'https://example.com/clip.mp4',
            });

            fetchMock
                .mockResolvedValueOnce(probeRes)
                .mockResolvedValueOnce(downloadRes);

            await svc.fetchToSession(session.id, 'https://example.com/clip.mp4');

            expect(sessionService.get(session.id)!.status).toBe('failed');
            expect(sessionService.get(session.id)!.error).toMatch(/no body/);
        });
    });

    describe('webhook delivery', () => {
        it('sends uploading then failed webhook on failure', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig({ withWebhook: true }));

            await svc.fetchToSession(session.id, 'ftp://example.com/file.mp4');

            const calls = webhookService.send.mock.calls.map(
                ([_url, _tok, payload]: any[]) => payload.status,
            );
            expect(calls).toEqual(['uploading', 'failed']);
        });

        it('cleans up partial files on failure', async () => {
            const svc = makeService();
            const session = sessionService.create(makeConfig());

            const body = Buffer.from('partial');
            fetchMock
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 200,
                        headers: { 'content-length': '10', 'content-type': 'video/mp4' },
                        url: 'https://example.com/clip.mp4',
                    }),
                )
                .mockResolvedValueOnce(
                    makeResponse({
                        status: 500,
                        body,
                        url: 'https://example.com/clip.mp4',
                    }),
                );

            await svc.fetchToSession(session.id, 'https://example.com/clip.mp4');

            const dest = join(workDir, session.id, 'clip.mp4');
            expect(existsSync(dest)).toBe(false);
        });
    });
});
