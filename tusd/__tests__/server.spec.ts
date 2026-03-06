import { jest } from '@jest/globals';
import { TusdServer } from '../src/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

function httpRequest(
    options: http.RequestOptions,
    body?: string | Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString(),
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

describe('TusdServer integration', () => {
    let server: TusdServer;
    let uploadDir: string;
    let proxyPort: number;
    let proxyServer: http.Server;

    beforeAll(async () => {
        uploadDir = mkdtempSync(join(tmpdir(), 'tusd-test-'));

        const onUploadCreate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        const onUploadFinish = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

        server = new TusdServer({
            path: '/files/',
            directory: uploadDir,
            maxSize: 1024 * 1024,
            onIncomingRequest: async (req) => {
                const auth = req.headers['authorization'];
                if (auth !== 'Bearer test-token') {
                    throw { status_code: 401, body: 'Unauthorized' };
                }
            },
            onUploadCreate,
            onUploadFinish,
        });

        await server.start();

        // Create a small proxy HTTP server so we have a known port to test against
        proxyServer = http.createServer((req, res) => {
            server.handle(req, res);
        });

        await new Promise<void>((resolve) => {
            proxyServer.listen(0, '127.0.0.1', () => resolve());
        });

        const addr = proxyServer.address();
        proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
    }, 15000);

    afterAll(async () => {
        await new Promise<void>((resolve) => proxyServer?.close(() => resolve()));
        await server?.stop();
        try {
            rmSync(uploadDir, { recursive: true, force: true });
        } catch {
            // cleanup best-effort
        }
    });

    it('should reject unauthenticated requests', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/files/',
            method: 'POST',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '100',
            },
        });

        expect(res.status).toBe(401);
        expect(res.body).toBe('Unauthorized');
    });

    it('should accept authenticated requests and create an upload', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/files/',
            method: 'POST',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '11',
                'Upload-Metadata': 'filename dGVzdC50eHQ=',
                Authorization: 'Bearer test-token',
            },
        });

        expect(res.status).toBe(201);
        expect(res.headers['location']).toBeDefined();
    });

    it('should upload data via PATCH and complete', async () => {
        // Create upload
        const createRes = await httpRequest({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: '/files/',
            method: 'POST',
            headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '11',
                'Upload-Metadata': 'filename dGVzdC50eHQ=',
                Authorization: 'Bearer test-token',
            },
        });

        expect(createRes.status).toBe(201);
        const location = createRes.headers['location'] as string;
        expect(location).toBeDefined();

        // Extract path from location
        const url = new URL(location, `http://127.0.0.1:${proxyPort}`);

        // Upload data
        const patchRes = await httpRequest(
            {
                hostname: '127.0.0.1',
                port: proxyPort,
                path: url.pathname,
                method: 'PATCH',
                headers: {
                    'Tus-Resumable': '1.0.0',
                    'Upload-Offset': '0',
                    'Content-Type': 'application/offset+octet-stream',
                    Authorization: 'Bearer test-token',
                },
            },
            'hello world',
        );

        expect(patchRes.status).toBe(204);
        expect(patchRes.headers['upload-offset']).toBe('11');
    });
});
