import { jest } from '@jest/globals';
import { HookServer } from '../src/hook-server.js';
import type { TusdServerConfig, TusdHookPayload } from '../src/types.js';
import http from 'node:http';

function makePayload(
    type: string,
    overrides?: Partial<TusdHookPayload['Event']['Upload']>,
): TusdHookPayload {
    return {
        Type: type,
        Event: {
            Upload: {
                ID: 'test-upload-id',
                Size: 1024,
                SizeIsDeferred: false,
                Offset: 0,
                MetaData: { sessionId: 'session-1', filename: 'test.mp4' },
                IsPartial: false,
                IsFinal: false,
                PartialUploads: null,
                Storage: { Type: 'filestore', Path: '/tmp/uploads/test-upload-id' },
                ...overrides,
            },
            HTTPRequest: {
                Method: 'POST',
                URI: '/api/tus',
                RemoteAddr: '127.0.0.1',
                Header: {
                    Authorization: ['Bearer tok_abc123'],
                    'Content-Type': ['application/offset+octet-stream'],
                },
            },
        },
    };
}

function postToHookServer(
    port: number,
    payload: TusdHookPayload,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/hooks',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode || 0,
                        body: Buffer.concat(chunks).toString(),
                    });
                });
            },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

describe('HookServer', () => {
    let hookServer: HookServer;
    let port: number;

    afterEach(async () => {
        await hookServer?.stop();
    });

    it('should start on an ephemeral port', async () => {
        const config: TusdServerConfig = {
            path: '/api/tus',
            directory: '/tmp/test-uploads',
        };
        hookServer = new HookServer(config);
        port = await hookServer.start();
        expect(port).toBeGreaterThan(0);
    });

    it('should dispatch pre-create and allow upload', async () => {
        const onUploadCreate = jest.fn().mockResolvedValue(undefined);
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onUploadCreate,
        });
        port = await hookServer.start();

        const payload = makePayload('pre-create');
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200);
        expect(onUploadCreate).toHaveBeenCalledTimes(1);
        expect(onUploadCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'POST',
                url: '/api/tus',
                headers: expect.objectContaining({
                    authorization: 'Bearer tok_abc123',
                }),
            }),
            expect.objectContaining({
                id: 'test-upload-id',
                metadata: { sessionId: 'session-1', filename: 'test.mp4' },
            }),
        );
    });

    it('should dispatch pre-create and reject upload when callback throws', async () => {
        const onUploadCreate = jest
            .fn()
            .mockRejectedValue({ status_code: 404, body: 'Session not found' });
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onUploadCreate,
        });
        port = await hookServer.start();

        const payload = makePayload('pre-create');
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200); // tusd expects 200 with RejectUpload in body
        const body = JSON.parse(res.body);
        expect(body.RejectUpload).toBe(true);
        expect(body.HttpResponse.StatusCode).toBe(404);
        expect(body.HttpResponse.Body).toBe('Session not found');
    });

    it('should dispatch post-finish', async () => {
        const onUploadFinish = jest.fn().mockResolvedValue(undefined);
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onUploadFinish,
        });
        port = await hookServer.start();

        const payload = makePayload('post-finish', {
            Offset: 1024,
            Storage: { Type: 'filestore', Path: '/tmp/uploads/final-id' },
        });
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200);
        expect(onUploadFinish).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                id: 'test-upload-id',
                offset: 1024,
                storage: { path: '/tmp/uploads/final-id' },
            }),
        );
    });

    it('should dispatch post-receive to onProgress', async () => {
        const onProgress = jest.fn().mockResolvedValue(undefined);
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onProgress,
        });
        port = await hookServer.start();

        const payload = makePayload('post-receive', { Offset: 512 });
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200);
        expect(onProgress).toHaveBeenCalledWith(
            expect.objectContaining({ offset: 512 }),
        );
    });

    it('should handle partial uploads (no metadata)', async () => {
        const onUploadCreate = jest.fn().mockResolvedValue(undefined);
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onUploadCreate,
        });
        port = await hookServer.start();

        const payload = makePayload('pre-create', {
            IsPartial: true,
            MetaData: {},
        });
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200);
        expect(onUploadCreate).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                isPartial: true,
                metadata: {},
            }),
        );
    });

    it('should map concatenated final upload correctly', async () => {
        const onUploadFinish = jest.fn().mockResolvedValue(undefined);
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
            onUploadFinish,
        });
        port = await hookServer.start();

        const payload = makePayload('post-finish', {
            IsFinal: true,
            PartialUploads: ['part-1', 'part-2', 'part-3'],
        });
        const res = await postToHookServer(port, payload);

        expect(res.status).toBe(200);
        expect(onUploadFinish).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                isFinal: true,
                partialUploads: ['part-1', 'part-2', 'part-3'],
            }),
        );
    });

    it('should acknowledge unknown hook types with 200', async () => {
        hookServer = new HookServer({
            path: '/api/tus',
            directory: '/tmp/test-uploads',
        });
        port = await hookServer.start();

        const payload = makePayload('post-create');
        const res = await postToHookServer(port, payload);
        expect(res.status).toBe(200);
    });
});
