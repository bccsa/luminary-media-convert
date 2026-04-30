import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { proxyToTusd } from '../src/proxy.js';

describe('proxyToTusd', () => {
    let targetPort: number;
    let targetServer: ReturnType<typeof createServer>;
    let receivedHeaders: IncomingMessage['headers'];

    beforeAll(
        () =>
            new Promise<void>((resolve) => {
                targetServer = createServer((req, res) => {
                    receivedHeaders = req.headers;
                    res.writeHead(200);
                    res.end('ok');
                });
                targetServer.listen(0, '127.0.0.1', () => {
                    targetPort = (targetServer.address() as any).port;
                    resolve();
                });
            }),
    );

    afterAll(
        () =>
            new Promise<void>((resolve) => {
                targetServer.close(() => resolve());
            }),
    );

    it('should strip hop-by-hop headers and forward safe headers', () =>
        new Promise<void>((resolve, reject) => {
            const clientServer = createServer((req, res) => {
                proxyToTusd(req, res, targetPort, '/api/tus');
                res.on('finish', () => {
                    try {
                        // Hop-by-hop headers from client should be stripped
                        expect(receivedHeaders['upgrade']).toBeUndefined();
                        expect(receivedHeaders['proxy-authorization']).toBeUndefined();
                        expect(receivedHeaders['trailer']).toBeUndefined();
                        // Safe headers should be forwarded
                        expect(receivedHeaders['content-type']).toBe('application/json');
                        expect(receivedHeaders['authorization']).toBe('Bearer test');
                        // Host should be rewritten to tusd
                        expect(receivedHeaders['host']).toBe(`127.0.0.1:${targetPort}`);
                        clientServer.close();
                        resolve();
                    } catch (err) {
                        clientServer.close();
                        reject(err);
                    }
                });
            });

            clientServer.listen(0, '127.0.0.1', () => {
                const port = (clientServer.address() as any).port;
                const req = httpRequest(
                    {
                        hostname: '127.0.0.1',
                        port,
                        path: '/api/tus',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer test',
                            'Upgrade': 'websocket',
                            'Proxy-Authorization': 'Basic abc',
                            'Trailer': 'X-Checksum',
                        },
                    },
                    () => {},
                );
                req.end('{}');
            });
        }));
});
