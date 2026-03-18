import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockStart = vi.fn();
const mockAbort = vi.fn();

vi.mock('tus-js-client', () => {
    const Upload = vi.fn(function (this: any) {
        this.start = mockStart;
        this.abort = mockAbort;
    });
    return { Upload };
});

import * as tus from 'tus-js-client';
import {
    createSession,
    deleteSession,
    uploadFile,
    startEncode,
    getSessionStatus,
} from './api';

describe('api', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({}), { status: 200 }),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createSession', () => {
        it('calls SaaS Service with Auth0 JWT', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(
                    JSON.stringify({
                        sessionId: 'sess-1',
                        encodingApiUrl: 'http://localhost:3000',
                        sessionToken: 'sess_abc',
                        maxUploadSize: 10737418240,
                    }),
                    { status: 201 },
                ),
            );

            const result = await createSession(
                { s3: { endPoint: 'minio', bucket: 'b', accessKey: 'a', secretKey: 's' } } as any,
                'jwt-token',
            );

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            expect(result.sessionId).toBe('sess-1');
            expect(result.encodingApiUrl).toBe('http://localhost:3000');
            expect(result.sessionToken).toBe('sess_abc');
        });

        it('throws on error response', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Bad request' }), { status: 400 }),
            );

            await expect(
                createSession({ s3: {} } as any, 'jwt-token'),
            ).rejects.toThrow('Bad request');
        });
    });

    describe('deleteSession', () => {
        it('calls SaaS Service with Auth0 JWT', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await deleteSession('sess-1', 'jwt-token');

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/sess-1'),
                expect.objectContaining({
                    method: 'DELETE',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
        });
    });

    describe('uploadFile', () => {
        it('passes session token and endpoint to tus Upload', () => {
            const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
            uploadFile('https://api.example.com/api/tus', 'sess-1', 'sess_abc', file);

            expect(tus.Upload).toHaveBeenCalledWith(
                file,
                expect.objectContaining({
                    endpoint: 'https://api.example.com/api/tus',
                    removeFingerprintOnSuccess: true,
                    chunkSize: 50 * 1024 * 1024,
                    metadata: {
                        sessionId: 'sess-1',
                        filename: 'test.mp4',
                        filetype: 'video/mp4',
                    },
                    headers: {
                        Authorization: 'Bearer sess_abc',
                    },
                }),
            );
            expect(mockStart).toHaveBeenCalled();
        });
    });

    describe('startEncode', () => {
        it('calls Encoding API with session token', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(
                    JSON.stringify({ sessionId: 'sess-1', status: 'queued' }),
                    { status: 202 },
                ),
            );

            const result = await startEncode(
                'http://localhost:3000',
                'sess-1',
                { type: 'video' } as any,
                'sess_abc',
            );

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:3000/api/sessions/sess-1/encode',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer sess_abc',
                    }),
                }),
            );
            expect(result.status).toBe('queued');
        });
    });

    describe('getSessionStatus', () => {
        it('calls Encoding API with session token', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(
                    JSON.stringify({ sessionId: 'sess-1', status: 'encoding', progress: 45 }),
                    { status: 200 },
                ),
            );

            const result = await getSessionStatus('http://localhost:3000', 'sess-1', 'sess_abc');

            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:3000/api/sessions/sess-1',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer sess_abc',
                    }),
                }),
            );
            expect(result.status).toBe('encoding');
            expect(result.progress).toBe(45);
        });
    });
});
