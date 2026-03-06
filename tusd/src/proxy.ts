import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Proxies an incoming HTTP request to the tusd Go binary.
 * Rewrites the Host header and pipes the request/response bodies.
 */
export function proxyToTusd(
    req: IncomingMessage,
    res: ServerResponse,
    tusdPort: number,
    basePath: string,
): void {
    const headers = { ...req.headers, host: `127.0.0.1:${tusdPort}` };

    const proxyReq = httpRequest(
        {
            hostname: '127.0.0.1',
            port: tusdPort,
            path: req.url,
            method: req.method,
            headers,
        },
        (proxyRes) => {
            res.writeHead(
                proxyRes.statusCode || 502,
                proxyRes.headers,
            );
            proxyRes.pipe(res, { end: true });
        },
    );

    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy error: ${err.message}`);
        }
    });

    req.pipe(proxyReq, { end: true });
}
