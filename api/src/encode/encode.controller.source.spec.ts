import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    createReadStream,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HttpException } from '@nestjs/common';
import { EncodeController } from './encode.controller.js';
import { SessionService, type Session } from './services/session.service.js';

/**
 * `GET /api/sessions/:id/source`, over real HTTP: byte ranges are answered by
 * Express's `send`, so they are only worth testing on the wire.
 */
describe('EncodeController source file', () => {
    let workDir: string;
    let sessionService: SessionService;
    let session: Session;
    let app: express.Express;
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'luminary-source-'));
        process.env.WORK_DIR = workDir;
        sessionService = new SessionService({ emit: () => {} } as any);
        session = sessionService.create({
            s3: {
                endPoint: 's3.example.com',
                bucket: 'test',
                accessKey: 'key',
                secretKey: 'secret',
            },
        } as any);
        session.filePath = join(workDir, 'source.mp4');
        session.status = 'ready' as Session['status'];
        writeFileSync(session.filePath, bytes);

        const controller = new EncodeController(
            sessionService,
            ...(Array.from({ length: 11 }, () => ({})) as [any])
        );
        app = express();
        app.get('/api/sessions/:id/source', (req, res) => {
            try {
                controller.getSource(
                    req.params.id,
                    req.query.token as string,
                    res
                );
            } catch (err) {
                res.status(
                    err instanceof HttpException ? err.getStatus() : 500
                ).end();
            }
        });
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
        delete process.env.WORK_DIR;
    });

    const url = (token = session.sessionToken, id = session.id) =>
        `/api/sessions/${id}/source?token=${token}`;

    it('serves the whole file', async () => {
        const res = await request(app).get(url()).buffer(true);
        expect(res.status).toBe(200);
        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(Buffer.compare(res.body, bytes)).toBe(0);
    });

    it('serves a byte range', async () => {
        const res = await request(app).get(url()).set('Range', 'bytes=100-199');
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 100-199/1000');
        expect(Buffer.compare(res.body, bytes.subarray(100, 200))).toBe(0);
    });

    it('serves the last bytes for a suffix range', async () => {
        const res = await request(app).get(url()).set('Range', 'bytes=-100');
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 900-999/1000');
    });

    it('refuses a range past the end', async () => {
        const res = await request(app)
            .get(url())
            .set('Range', 'bytes=5000-6000');
        expect(res.status).toBe(416);
    });

    it('answers HEAD with the size and no body', async () => {
        const res = await request(app).head(url());
        expect(res.status).toBe(200);
        expect(res.headers['content-length']).toBe('1000');
    });

    it('lets the preview read it from another origin', async () => {
        const res = await request(app).get(url()).set('Range', 'bytes=0-0');
        expect(res.headers['cross-origin-resource-policy']).toBe(
            'cross-origin'
        );
    });

    it('refuses a request without a token', async () => {
        const res = await request(app).get(
            `/api/sessions/${session.id}/source`
        );
        expect(res.status).toBe(401);
    });

    it("refuses another session's token", async () => {
        const other = sessionService.create({} as any);
        const res = await request(app).get(url(other.sessionToken));
        expect(res.status).toBe(401);
    });

    it.each(['created', 'uploading'])(
        'has nothing to serve while the session is %s',
        async (status) => {
            session.status = status as Session['status'];
            const res = await request(app).get(url());
            expect(res.status).toBe(404);
        }
    );

    it('serves only an absolute path', async () => {
        session.filePath = 'source.mp4';
        const res = await request(app).get(url());
        expect(res.status).toBe(404);
    });

    it('answers 404 once the file is gone from disk', async () => {
        rmSync(session.filePath!);
        const res = await request(app).get(url());
        expect(res.status).toBe(404);
    });

    it('serves a file under a dot-folder', async () => {
        // The source is wherever the user keeps it.
        const hidden = join(workDir, '.hidden');
        rmSync(hidden, { recursive: true, force: true });
        mkdirSync(hidden);
        session.filePath = join(hidden, 'source.mp4');
        writeFileSync(session.filePath, bytes);
        const res = await request(app).get(url()).set('Range', 'bytes=0-9');
        expect(res.status).toBe(206);
    });
});

/** `GET /api/sessions/:id/preview/r:rendition/:filename`, over real HTTP. */
describe('EncodeController preview segment', () => {
    let workDir: string;
    let sessionService: SessionService;
    let session: Session;
    /** The file the stub service opens for each request, as the service does. */
    let segment: { path: string; size: number } | null;
    let app: express.Express;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'luminary-segment-'));
        sessionService = new SessionService({ emit: () => {} } as any);
        session = sessionService.create({} as any);
        segment = null;
        const previewService = {
            ensureReady: async () => {},
            getSegmentStream: async () =>
                segment && {
                    stream: createReadStream(segment.path),
                    size: segment.size,
                },
        };
        const stubs = Array.from({ length: 11 }, () => ({})) as any[];
        stubs[3] = previewService;
        const controller = new EncodeController(
            sessionService,
            ...(stubs as [any])
        );
        app = express();
        app.get(
            '/api/sessions/:id/preview/r:rendition/:filename',
            (req, res) => {
                controller
                    .getPreviewSegment(
                        req.params.id,
                        req.params.rendition,
                        req.params.filename,
                        req.query.token as string,
                        undefined,
                        res
                    )
                    .catch((err) =>
                        res
                            .status(
                                err instanceof HttpException
                                    ? err.getStatus()
                                    : 500
                            )
                            .end()
                    );
            }
        );
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    const url = () =>
        `/api/sessions/${session.id}/preview/r0/segment3.ts?token=${session.sessionToken}`;

    it('serves the segment', async () => {
        const path = join(workDir, 'segment3.ts');
        writeFileSync(path, Buffer.alloc(188, 0x47));
        segment = { path, size: 188 };
        const res = await request(app).get(url()).buffer(true);
        expect(res.status).toBe(200);
        expect(res.headers['content-length']).toBe('188');
    });

    it('ends the response, without taking the process down, when the read fails', async () => {
        // A file that is gone by the time it is read: the stream errors after
        // the headers are out.
        segment = { path: join(workDir, 'evicted.ts'), size: 188 };
        await expect(request(app).get(url())).rejects.toThrow();
    });
});
