import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockStart = vi.fn();
const mockAbort = vi.fn();
let lastUploadOpts: any = null;

vi.mock('tus-js-client', () => {
    const Upload = vi.fn(function (this: any, _file: any, opts: any) {
        this.start = mockStart;
        this.abort = mockAbort;
        lastUploadOpts = opts;
    });
    return { Upload };
});

import * as tus from 'tus-js-client';
import {
    checkIdentity,
    createSession,
    deleteSession,
    uploadFile,
    startEncode,
    getSessionStatus,
    subscribeSessionEvents,
    createApiKey,
    listApiKeys,
    revokeApiKey,
    listS3Configs,
    createS3Config,
    getS3Config,
    updateS3Config,
    deleteS3Config,
    listSessions,
    getSessionDetail,
    updateSessionName,
    importSession,
    hlsRead,
    hlsMutate,
    checkPrefix,
    moveSessionFiles,
    renameSessionPrefix,
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

    describe('checkIdentity', () => {
        it('calls SaaS /saas/me with Auth0 JWT', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(
                    JSON.stringify({ id: 'user:1', email: 'test@test.com', name: 'Test', status: 'active' }),
                    { status: 200 },
                ),
            );

            const result = await checkIdentity('jwt-token');

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/me'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            expect(result.status).toBe('active');
        });

        it('throws on 401 (disabled/unprovisioned)', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Account disabled' }), { status: 401 }),
            );

            await expect(checkIdentity('jwt-token')).rejects.toThrow('Account disabled');
        });
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

            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toContain('/saas/sessions/sess-1');
            expect(calledUrl).not.toContain('deleteFiles');
        });

        it('appends deleteFiles=true when requested', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await deleteSession('sess-1', 'jwt-token', true);

            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toContain('/saas/sessions/sess-1?deleteFiles=true');
        });

        it('does not append deleteFiles when false', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await deleteSession('sess-1', 'jwt-token', false);

            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).not.toContain('deleteFiles');
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

        it('throws on error response', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
            );

            await expect(
                getSessionStatus('http://localhost:3000', 'sess-1', 'sess_abc'),
            ).rejects.toThrow('Not found');
        });

        it('throws with status when no message in error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('{}', { status: 500 }),
            );

            await expect(
                getSessionStatus('http://localhost:3000', 'sess-1', 'sess_abc'),
            ).rejects.toThrow('Status poll failed (500)');
        });

        it('handles non-JSON error response', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
            );

            await expect(
                getSessionStatus('http://localhost:3000', 'sess-1', 'sess_abc'),
            ).rejects.toThrow('Status poll failed (502)');
        });
    });

    describe('subscribeSessionEvents', () => {
        it('creates EventSource with session token', () => {
            const instances: any[] = [];
            const MockEventSource = vi.fn(function (this: any) {
                this.onmessage = null;
                this.onerror = null;
                this.close = vi.fn();
                instances.push(this);
            }) as any;
            vi.stubGlobal('EventSource', MockEventSource);

            const onEvent = vi.fn();
            subscribeSessionEvents('http://localhost:3000', 'sess-1', 'sess_abc', onEvent);

            expect(MockEventSource).toHaveBeenCalledWith(
                'http://localhost:3000/api/sessions/sess-1/events?token=sess_abc',
            );

            // Simulate message
            instances[0].onmessage({ data: JSON.stringify({ status: 'encoding' }) });
            expect(onEvent).toHaveBeenCalledWith({ status: 'encoding' });

            vi.unstubAllGlobals();
        });

        it('ignores parse errors', () => {
            const instances: any[] = [];
            const MockEventSource = vi.fn(function (this: any) {
                this.onmessage = null;
                this.onerror = null;
                instances.push(this);
            }) as any;
            vi.stubGlobal('EventSource', MockEventSource);

            const onEvent = vi.fn();
            subscribeSessionEvents('http://localhost:3000', 'sess-1', 'sess_abc', onEvent);

            instances[0].onmessage({ data: 'bad json' });
            expect(onEvent).not.toHaveBeenCalled();

            vi.unstubAllGlobals();
        });

        it('sets onerror handler when provided', () => {
            const instances: any[] = [];
            const MockEventSource = vi.fn(function (this: any) {
                this.onmessage = null;
                this.onerror = null;
                instances.push(this);
            }) as any;
            vi.stubGlobal('EventSource', MockEventSource);

            const onEvent = vi.fn();
            const onError = vi.fn();
            subscribeSessionEvents('http://localhost:3000', 'sess-1', 'sess_abc', onEvent, onError);

            expect(instances[0].onerror).toBe(onError);

            vi.unstubAllGlobals();
        });
    });

    describe('startEncode error', () => {
        it('throws on error response', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Invalid config' }), { status: 400 }),
            );

            await expect(
                startEncode('http://localhost:3000', 'sess-1', {} as any, 'sess_abc'),
            ).rejects.toThrow('Invalid config');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', { status: 500 }),
            );

            await expect(
                startEncode('http://localhost:3000', 'sess-1', {} as any, 'sess_abc'),
            ).rejects.toThrow('Encode start failed (500)');
        });
    });

    describe('deleteSession error', () => {
        it('throws on error response', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Session locked' }), { status: 409 }),
            );

            await expect(deleteSession('sess-1', 'jwt-token')).rejects.toThrow('Session locked');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', { status: 500 }),
            );

            await expect(deleteSession('sess-1', 'jwt-token')).rejects.toThrow(
                'Session deletion failed (500)',
            );
        });
    });

    describe('checkIdentity error', () => {
        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', { status: 403 }),
            );

            await expect(checkIdentity('jwt-token')).rejects.toThrow(
                'Identity check failed (403)',
            );
        });
    });

    describe('createSession error', () => {
        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('not json', { status: 502 }),
            );

            await expect(
                createSession({ s3: {} } as any, 'jwt-token'),
            ).rejects.toThrow('Session creation failed (502)');
        });
    });

    describe('createApiKey', () => {
        it('generates key client-side, sends hash, returns key', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ id: 'apikey:1', name: 'Test' }), { status: 201 }),
            );

            // Mock crypto.subtle.digest
            const mockDigest = vi.fn().mockResolvedValue(new ArrayBuffer(32));
            vi.stubGlobal('crypto', {
                getRandomValues: (arr: Uint8Array) => {
                    arr.fill(42);
                    return arr;
                },
                subtle: { digest: mockDigest },
            });

            const result = await createApiKey('jwt-token', 'My Key');

            expect(result.id).toBe('apikey:1');
            expect(result.key).toMatch(/^lmc_/);

            // Verify hash was sent, not raw key
            const callBody = JSON.parse(
                (vi.mocked(fetch).mock.calls[0][1] as any).body,
            );
            expect(callBody.name).toBe('My Key');
            expect(callBody.keyHash).toBeDefined();
            expect(callBody.prefix).toMatch(/^lmc_/);

            vi.unstubAllGlobals();
        });

        it('throws on error response', async () => {
            vi.stubGlobal('crypto', {
                getRandomValues: (arr: Uint8Array) => {
                    arr.fill(1);
                    return arr;
                },
                subtle: { digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)) },
            });
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Duplicate name' }), { status: 409 }),
            );

            await expect(createApiKey('jwt-token', 'Dup')).rejects.toThrow('Duplicate name');

            vi.unstubAllGlobals();
        });

        it('throws with status when no message', async () => {
            vi.stubGlobal('crypto', {
                getRandomValues: (arr: Uint8Array) => {
                    arr.fill(1);
                    return arr;
                },
                subtle: { digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)) },
            });
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(createApiKey('jwt-token', 'Key')).rejects.toThrow(
                'API key creation failed (500)',
            );

            vi.unstubAllGlobals();
        });
    });

    describe('listApiKeys', () => {
        it('returns list of API keys', async () => {
            const keys = [{ id: 'k1', name: 'Key 1' }];
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(keys), { status: 200 }),
            );

            const result = await listApiKeys('jwt-token');

            expect(result).toEqual(keys);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/keys'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            );

            await expect(listApiKeys('bad-token')).rejects.toThrow('Unauthorized');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(listApiKeys('jwt-token')).rejects.toThrow(
                'Failed to list API keys (500)',
            );
        });
    });

    describe('revokeApiKey', () => {
        it('sends DELETE to revoke a key', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await revokeApiKey('jwt-token', 'apikey:1');

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/keys/apikey:1'),
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Already revoked' }), { status: 409 }),
            );

            await expect(revokeApiKey('jwt-token', 'k1')).rejects.toThrow('Already revoked');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(revokeApiKey('jwt-token', 'k1')).rejects.toThrow(
                'API key revocation failed (500)',
            );
        });
    });

    describe('listS3Configs', () => {
        it('returns S3 configs', async () => {
            const configs = { configs: [{ id: 'c1', name: 'Config 1' }] };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(configs), { status: 200 }),
            );

            const result = await listS3Configs('jwt-token');

            expect(result).toEqual(configs);
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            );

            await expect(listS3Configs('bad')).rejects.toThrow('Unauthorized');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(listS3Configs('jwt-token')).rejects.toThrow(
                'Failed to list S3 configs (500)',
            );
        });
    });

    describe('createS3Config', () => {
        it('creates S3 config', async () => {
            const config = { id: 'c1', name: 'New' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(config), { status: 201 }),
            );

            const result = await createS3Config('jwt-token', { name: 'New', endPoint: 'e', bucket: 'b', accessKey: 'a', secretKey: 's' });

            expect(result).toEqual(config);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/s3-configs'),
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Validation failed' }), { status: 400 }),
            );

            await expect(createS3Config('jwt-token', {})).rejects.toThrow('Validation failed');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(createS3Config('jwt-token', {})).rejects.toThrow(
                'S3 config creation failed (500)',
            );
        });
    });

    describe('getS3Config', () => {
        it('gets S3 config detail', async () => {
            const config = { id: 'c1', accessKey: 'AKID' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(config), { status: 200 }),
            );

            const result = await getS3Config('jwt-token', 'c1');

            expect(result).toEqual(config);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/s3-configs/c1'),
                expect.any(Object),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
            );

            await expect(getS3Config('jwt-token', 'bad')).rejects.toThrow('Not found');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(getS3Config('jwt-token', 'c1')).rejects.toThrow(
                'Failed to get S3 config (500)',
            );
        });
    });

    describe('updateS3Config', () => {
        it('updates S3 config', async () => {
            const config = { id: 'c1', name: 'Updated' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(config), { status: 200 }),
            );

            const result = await updateS3Config('jwt-token', 'c1', { name: 'Updated' });

            expect(result).toEqual(config);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/s3-configs/c1'),
                expect.objectContaining({ method: 'PATCH' }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
            );

            await expect(updateS3Config('jwt-token', 'c1', {})).rejects.toThrow('Forbidden');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(updateS3Config('jwt-token', 'c1', {})).rejects.toThrow(
                'S3 config update failed (500)',
            );
        });
    });

    describe('deleteS3Config', () => {
        it('deletes S3 config', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

            await deleteS3Config('jwt-token', 'c1');

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/s3-configs/c1'),
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
            );

            await expect(deleteS3Config('jwt-token', 'c1')).rejects.toThrow('Not found');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(deleteS3Config('jwt-token', 'c1')).rejects.toThrow(
                'S3 config deletion failed (500)',
            );
        });
    });

    describe('listSessions', () => {
        it('returns sessions with all query params', async () => {
            const data = { sessions: [{ id: 's1' }], total: 1 };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(data), { status: 200 }),
            );

            const result = await listSessions('jwt-token', { limit: 10, skip: 5, status: 'completed' });

            expect(result).toEqual(data);
            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toContain('/saas/sessions');
            expect(calledUrl).toContain('limit=10');
            expect(calledUrl).toContain('skip=5');
            expect(calledUrl).toContain('status=completed');
            expect(vi.mocked(fetch).mock.calls[0][1]).toEqual(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
        });

        it('includes name param when provided', async () => {
            const data = { sessions: [{ id: 's1' }], total: 1 };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(data), { status: 200 }),
            );

            await listSessions('jwt-token', { name: 'My Project' });

            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toContain('name=My+Project');
        });

        it('calls without query params when opts omitted', async () => {
            const data = { sessions: [], total: 0 };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(data), { status: 200 }),
            );

            const result = await listSessions('jwt-token');

            expect(result).toEqual(data);
            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toMatch(/\/saas\/sessions$/);
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
            );

            await expect(listSessions('bad-token')).rejects.toThrow('Unauthorized');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(listSessions('jwt-token')).rejects.toThrow(
                'Failed to list sessions (500)',
            );
        });
    });

    describe('getSessionDetail', () => {
        it('returns session detail', async () => {
            const detail = { id: 's1', status: 'completed', name: 'Test Session' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(detail), { status: 200 }),
            );

            const result = await getSessionDetail('jwt-token', 's1');

            expect(result).toEqual(detail);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/s1'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
            );

            await expect(getSessionDetail('jwt-token', 'bad-id')).rejects.toThrow('Not found');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(getSessionDetail('jwt-token', 's1')).rejects.toThrow(
                'Failed to get session detail (500)',
            );
        });
    });

    describe('updateSessionName', () => {
        it('sends PATCH with name in body', async () => {
            const updated = { id: 's1', name: 'New Name' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(updated), { status: 200 }),
            );

            const result = await updateSessionName('jwt-token', 's1', 'New Name');

            expect(result).toEqual(updated);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/s1/name'),
                expect.objectContaining({
                    method: 'PATCH',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            const callBody = JSON.parse(
                (vi.mocked(fetch).mock.calls[0][1] as any).body,
            );
            expect(callBody).toEqual({ name: 'New Name' });
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
            );

            await expect(updateSessionName('jwt-token', 's1', 'X')).rejects.toThrow('Forbidden');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(updateSessionName('jwt-token', 's1', 'X')).rejects.toThrow(
                'Failed to update session name (500)',
            );
        });
    });

    describe('checkPrefix', () => {
        it('sends GET with s3ConfigId and prefix query params', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ exists: true, count: 5 }), { status: 200 }),
            );

            const result = await checkPrefix('jwt-token', 'cfg-1', 'output/');

            expect(result).toEqual({ exists: true, count: 5 });
            const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
            expect(calledUrl).toContain('/saas/sessions/check-prefix');
            expect(calledUrl).toContain('s3ConfigId=cfg-1');
            expect(calledUrl).toContain('prefix=output');
            expect(vi.mocked(fetch).mock.calls[0][1]).toEqual(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
            );

            await expect(checkPrefix('jwt-token', 'cfg-1', 'x/')).rejects.toThrow('Forbidden');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(checkPrefix('jwt-token', 'cfg-1', 'x/')).rejects.toThrow(
                'Check prefix failed (500)',
            );
        });
    });

    describe('moveSessionFiles', () => {
        it('sends POST with targetS3ConfigId and newPathPrefix', async () => {
            const moved = { sessionId: 's1', status: 'completed', files: ['new/master.m3u8'] };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(moved), { status: 200 }),
            );

            const result = await moveSessionFiles('jwt-token', 's1', 'cfg-2', 'new/');

            expect(result).toEqual(moved);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/s1/move'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            const callBody = JSON.parse(
                (vi.mocked(fetch).mock.calls[0][1] as any).body,
            );
            expect(callBody).toEqual({ targetS3ConfigId: 'cfg-2', newPathPrefix: 'new/' });
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }),
            );

            await expect(moveSessionFiles('jwt-token', 's1', 'cfg-2', 'new/')).rejects.toThrow('Not found');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(moveSessionFiles('jwt-token', 's1', 'cfg-2', 'new/')).rejects.toThrow(
                'Move failed (500)',
            );
        });
    });

    describe('renameSessionPrefix', () => {
        it('sends POST with newPathPrefix', async () => {
            const renamed = { sessionId: 's1', status: 'completed' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(renamed), { status: 200 }),
            );

            const result = await renameSessionPrefix('jwt-token', 's1', 'renamed/');

            expect(result).toEqual(renamed);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/s1/rename-prefix'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            const callBody = JSON.parse(
                (vi.mocked(fetch).mock.calls[0][1] as any).body,
            );
            expect(callBody).toEqual({ newPathPrefix: 'renamed/' });
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Bad request' }), { status: 400 }),
            );

            await expect(renameSessionPrefix('jwt-token', 's1', 'x/')).rejects.toThrow('Bad request');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(renameSessionPrefix('jwt-token', 's1', 'x/')).rejects.toThrow(
                'Rename prefix failed (500)',
            );
        });
    });

    describe('hlsRead / hlsMutate', () => {
        it('hlsRead POSTs to the saas wrapper and returns the result', async () => {
            const payload = {
                master: { variants: [], media: [], audioGroups: [] },
                etag: 'abc',
                folderPrefix: 'out/',
                masterPlaylistKey: 'out/master.m3u8',
            };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(payload), { status: 200 }),
            );

            const result = await hlsRead('jwt', 'sess-1');
            expect(result).toEqual(payload);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/sess-1/hls/read'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
                }),
            );
        });

        it('hlsMutate sends ifMatch and operations in the body', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ editVersion: 3 }), { status: 200 }),
            );

            await hlsMutate('jwt', 'sess-1', 'etag-abc', [
                { type: 'upsertSubtitle', language: 'en', name: 'English', vttBase64: 'WEBVTT' },
            ]);

            const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
            expect(body.ifMatch).toBe('etag-abc');
            expect(body.operations).toHaveLength(1);
            expect(body.operations[0].type).toBe('upsertSubtitle');
        });

        it('hlsMutate throws HlsConflictError on 409 and exposes currentEtag', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(
                    JSON.stringify({ message: 'mismatch', currentEtag: 'live-etag' }),
                    { status: 409 },
                ),
            );

            await expect(hlsMutate('jwt', 'sess-1', 'stale', [])).rejects.toMatchObject({
                name: 'HlsConflictError',
                currentEtag: 'live-etag',
            });
        });

        it('hlsRead throws a generic Error on non-ok non-409 responses', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'nope' }), { status: 400 }),
            );
            await expect(hlsRead('jwt', 'sess-1')).rejects.toThrow('nope');
        });
    });

    describe('importSession', () => {
        it('sends POST with import data', async () => {
            const imported = { id: 's-imp', status: 'completed' };
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify(imported), { status: 201 }),
            );

            const importData = {
                s3ConfigId: 'c1',
                masterPlaylistKey: 'output/master.m3u8',
                folderPrefix: 'output/',
                encryptionKey: 'abc123',
            };
            const result = await importSession('jwt-token', importData);

            expect(result).toEqual(imported);
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining('/saas/sessions/import'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer jwt-token',
                    }),
                }),
            );
            const callBody = JSON.parse(
                (vi.mocked(fetch).mock.calls[0][1] as any).body,
            );
            expect(callBody).toEqual(importData);
        });

        it('throws on error', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response(JSON.stringify({ message: 'Invalid S3 config' }), { status: 400 }),
            );

            await expect(
                importSession('jwt-token', { s3ConfigId: 'bad' }),
            ).rejects.toThrow('Invalid S3 config');
        });

        it('throws with status when no message', async () => {
            vi.mocked(fetch).mockResolvedValue(
                new Response('err', { status: 500 }),
            );

            await expect(
                importSession('jwt-token', { s3ConfigId: 'c1' }),
            ).rejects.toThrow('Session import failed (500)');
        });
    });

    describe('uploadFile callbacks', () => {
        it('returns abort function that aborts upload', () => {
            const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
            const { abort } = uploadFile('https://api.example.com/api/tus', 'sess-1', 'sess_abc', file);

            abort();
            expect(mockAbort).toHaveBeenCalledWith(true);
        });

        it('resolves promise on onSuccess', async () => {
            const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
            const { promise } = uploadFile('https://api.example.com/api/tus', 'sess-1', 'sess_abc', file);

            // Trigger onSuccess callback
            lastUploadOpts.onSuccess();

            await expect(promise).resolves.toBeUndefined();
        });

        it('rejects promise on onError', async () => {
            const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
            const { promise } = uploadFile('https://api.example.com/api/tus', 'sess-1', 'sess_abc', file);

            // Trigger onError callback
            lastUploadOpts.onError(new Error('Upload failed'));

            await expect(promise).rejects.toThrow('Upload failed');
        });

        it('reports progress via onProgress', () => {
            const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
            const onProgress = vi.fn();
            uploadFile('https://api.example.com/api/tus', 'sess-1', 'sess_abc', file, onProgress);

            // Trigger onProgress callback
            lastUploadOpts.onProgress(500, 1000);

            expect(onProgress).toHaveBeenCalledWith(50);
        });
    });
});
