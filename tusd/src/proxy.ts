import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    // Note: transfer-encoding is intentionally NOT stripped here. Although it
    // is a hop-by-hop header per spec, we pipe the raw request body through
    // to tusd unchanged. Stripping it while forwarding a chunked body causes
    // tusd to misread the payload (content-length mismatch / truncated data).
]);

function filterHeaders(raw: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
    const filtered: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            filtered[key] = value;
        }
    }
    return filtered;
}

/**
 * Proxies an incoming HTTP request to the tusd Go binary.
 * Rewrites the Host header and pipes the request/response bodies.
 * Strips hop-by-hop headers to prevent protocol confusion.
 */
export function proxyToTusd(
    req: IncomingMessage,
    res: ServerResponse,
    tusdPort: number,
    basePath: string,
): void {
    const headers = { ...filterHeaders(req.headers), host: `127.0.0.1:${tusdPort}` };

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
