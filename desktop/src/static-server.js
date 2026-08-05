/**
 * The one origin the renderer sees.
 *
 * It serves the built Vue app and answers the `/saas/*` paths that app already
 * calls, so `app/src/api.ts` needs almost no change — it keeps talking to the
 * same URLs, and the access token it sends is simply ignored because there is
 * nobody to authenticate.
 *
 * Serving over loopback HTTP rather than file:// or a custom scheme is
 * deliberate: 127.0.0.1 is a secure context in Chromium, so history-mode
 * routing, localStorage, blob URLs, EventSource and crypto.subtle all keep
 * working exactly as they do on the web.
 *
 * The adapter owns S3 profiles and forwards everything else to the encoder with
 * the master key attached, so the key never reaches the renderer.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json',
};

export class AppServer {
    #server = null;

    /**
     * @param {object} deps
     * @param {import('./s3-configs.js').S3ConfigStore} deps.s3Configs
     * @param {() => {baseUrl: string, masterKey: string}} deps.encoder
     * @param {import('./session-index.js').SessionIndex} deps.sessionIndex
     * @param {string} [deps.rendererDir] built app/dist, when it exists
     */
    constructor({ s3Configs, encoder, sessionIndex, rendererDir }) {
        this.s3Configs = s3Configs;
        this.encoder = encoder;
        this.sessionIndex = sessionIndex;
        this.rendererDir = rendererDir;
    }

    async listen(port) {
        this.#server = createServer((req, res) => {
            this.#handle(req, res).catch((err) => {
                send(res, 500, { message: err.message });
            });
        });

        await new Promise((ok, fail) => {
            this.#server.once('error', fail);
            this.#server.listen(port, '127.0.0.1', ok);
        });

        return this.#server.address().port;
    }

    async close() {
        if (!this.#server) return;
        await new Promise((ok) => this.#server.close(ok));
        this.#server = null;
    }

    async #handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const path = url.pathname;

        if (path.startsWith('/saas/')) {
            // No CORS headers on purpose: the renderer is same-origin, and
            // anything else reaching this port has no business here.
            return this.#saas(req, res, url);
        }
        return this.#static(req, res, path);
    }

    // ---------------------------------------------------------------- adapter

    async #saas(req, res, url) {
        const path = url.pathname;
        const method = req.method;

        // /saas/me — the app blocks on this before rendering anything, and all
        // it really wants is where the encoder is.
        if (path === '/saas/me' && method === 'GET') {
            return send(res, 200, {
                id: 'local',
                email: 'local@localhost',
                name: 'Local',
                status: 'active',
                encodingApiUrl: this.encoder().baseUrl,
            });
        }

        if (path === '/saas/s3-configs') {
            if (method === 'GET') {
                return send(res, 200, { configs: this.s3Configs.list() });
            }
            if (method === 'POST') {
                const body = await readJson(req);
                return send(res, 201, this.s3Configs.create(body));
            }
        }

        if (path === '/saas/s3-configs/test' && method === 'POST') {
            return send(res, 200, await this.#testS3(await readJson(req)));
        }

        const configMatch = path.match(/^\/saas\/s3-configs\/([^/]+)$/);
        if (configMatch) {
            const id = decodeURIComponent(configMatch[1]);
            if (method === 'GET') {
                const config = this.s3Configs.get(id);
                return config
                    ? send(res, 200, config)
                    : send(res, 404, { message: 'S3 config not found' });
            }
            if (method === 'PATCH') {
                const updated = this.s3Configs.update(id, await readJson(req));
                return updated
                    ? send(res, 200, updated)
                    : send(res, 404, { message: 'S3 config not found' });
            }
            if (method === 'DELETE') {
                return this.s3Configs.remove(id)
                    ? send(res, 204)
                    : send(res, 404, { message: 'S3 config not found' });
            }
        }

        if (path === '/saas/sessions') {
            if (method === 'GET') return this.#listSessions(res, url);
            if (method === 'POST') return this.#createSession(req, res);
        }

        const sessionMatch = path.match(/^\/saas\/sessions\/([^/]+)(\/.*)?$/);
        if (sessionMatch) {
            const id = decodeURIComponent(sessionMatch[1]);
            const rest = sessionMatch[2] ?? '';
            return this.#sessionRoute(req, res, url, id, rest, method);
        }

        return send(res, 404, { message: `No route for ${method} ${path}` });
    }

    async #listSessions(res, url) {
        const params = new URLSearchParams(url.search);
        // The app calls this filter "name"; the encoder searches name or id.
        const search = params.get('name');
        if (search) params.set('search', search);
        params.delete('name');

        const body = await this.#encoderFetch(`/api/sessions?${params}`);
        return send(res, body.status, body.json);
    }

    async #createSession(req, res) {
        const dto = await readJson(req);

        // The renderer sends an s3ConfigId; credentials never go through it.
        const { s3ConfigId, pathPrefix, publicUrl, ...rest } = dto;
        const s3 = this.s3Configs.toEncoderS3(s3ConfigId, pathPrefix);
        if (!s3) {
            return send(res, 400, { message: 'Unknown or missing s3ConfigId' });
        }

        const created = await this.#encoderFetch('/api/sessions', {
            method: 'POST',
            body: { ...rest, s3 },
        });

        if (created.status >= 400) return send(res, created.status, created.json);

        // Remember which profile and prefix it used, so later playlist and
        // chapter edits resolve the same credentials and the same folder
        // without the renderer ever holding them. The session token is kept
        // too: the renderer talks to the encoder directly for SSE, preview
        // playback and thumbnails, and that is the credential it uses.
        this.sessionIndex.set(created.json.sessionId, {
            s3ConfigId,
            pathPrefix,
            publicUrl,
            sessionToken: created.json.sessionToken,
        });

        return send(res, 201, {
            ...created.json,
            encodingApiUrl: this.encoder().baseUrl,
        });
    }

    async #sessionRoute(req, res, url, id, rest, method) {
        // Straight pass-throughs.
        const passthrough = {
            'GET:': `/api/sessions/${id}`,
            'DELETE:': `/api/sessions/${id}`,
            'PATCH:/name': `/api/sessions/${id}/name`,
            'POST:/url-upload': `/api/sessions/${id}/url-upload`,
            'POST:/local-source': `/api/sessions/${id}/local-source`,
        }[`${method}:${rest}`];

        if (passthrough) {
            const body = ['POST', 'PATCH', 'PUT'].includes(method)
                ? await readJson(req)
                : undefined;
            const result = await this.#encoderFetch(passthrough, {
                method,
                body,
            });
            if (method === 'GET' && result.status === 200) {
                // The renderer needs the encoder URL to talk to it directly for
                // SSE, preview playback and thumbnails.
                const extra = this.sessionIndex.get(id) ?? {};
                return send(res, 200, {
                    ...result.json,
                    ...extra,
                    // Where the finished output can be read from. The encoder
                    // holds the S3 settings but never returns them, so without
                    // this the page cannot build a single object URL — playback
                    // and the storyboard both come back empty once an encode
                    // finishes. Credentials are not part of this view.
                    s3Config: this.s3Configs.publicView(
                        extra.s3ConfigId,
                        extra.pathPrefix
                    ),
                    encodingApiUrl: this.encoder().baseUrl,
                });
            }
            return send(res, result.status, result.json);
        }

        // Playlist and sidecar edits need S3 credentials inlined.
        const s3 = this.#resolveSessionS3(id);
        if (!s3) {
            return send(res, 400, {
                message: 'No S3 configuration recorded for this session',
            });
        }

        if (rest === '/hls/read' && method === 'POST') {
            return this.#forwardHls(res, '/api/hls/read', {
                ...(await readJson(req)),
                s3,
            });
        }
        if (rest === '/hls/mutate' && method === 'POST') {
            return this.#forwardHls(res, '/api/hls/mutate', {
                ...(await readJson(req)),
                s3,
            });
        }
        if (rest === '/chapters' && method === 'GET') {
            return this.#forwardHls(res, '/api/hls/chapters/read', {
                s3,
                folderPrefix: s3.pathPrefix ?? '',
                lang: url.searchParams.get('lang') || 'en',
            });
        }
        if (rest === '/chapters' && method === 'PUT') {
            return this.#forwardHls(res, '/api/hls/chapters/write', {
                s3,
                folderPrefix: s3.pathPrefix ?? '',
                lang: url.searchParams.get('lang') || 'en',
                ...(await readJson(req)),
            });
        }
        if (rest === '/waveform' && method === 'GET') {
            return this.#forwardHls(res, '/api/hls/waveform/read', {
                s3,
                folderPrefix: s3.pathPrefix ?? '',
            });
        }

        return send(res, 404, {
            message: `No route for ${method} /saas/sessions/:id${rest}`,
        });
    }

    async #forwardHls(res, path, body) {
        const result = await this.#encoderFetch(path, { method: 'POST', body });
        return send(res, result.status, result.json);
    }

    /** The S3 profile a session was created with, plus its prefix. */
    #resolveSessionS3(sessionId) {
        const entry = this.sessionIndex.get(sessionId);
        if (!entry?.s3ConfigId) return undefined;
        return this.s3Configs.toEncoderS3(entry.s3ConfigId, entry.pathPrefix);
    }

    /**
     * Reachability only — not a full S3 check.
     *
     * A real one needs a signed request, and the shell has no S3 client. This
     * catches the common failure (a typo'd or unreachable endpoint) and says
     * plainly that it has not verified credentials or the bucket, rather than
     * reporting a pass it did not establish.
     */
    async #testS3(input) {
        const config = input.configId
            ? this.s3Configs.get(input.configId)
            : input;
        if (!config?.endPoint) {
            return { ok: false, reachable: false, message: 'No endpoint given' };
        }

        const scheme = config.useSSL === false ? 'http' : 'https';
        const host = String(config.endPoint).replace(/^https?:\/\//, '');
        const url = `${scheme}://${host}${config.port ? `:${config.port}` : ''}/`;

        try {
            await fetch(url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(8000),
            });
            return {
                ok: true,
                reachable: true,
                message:
                    'Endpoint responded. Credentials and bucket access are not checked here — the first encode will confirm those.',
            };
        } catch (err) {
            return {
                ok: false,
                reachable: false,
                message: `Could not reach ${url}: ${err.message}`,
            };
        }
    }

    async #encoderFetch(path, { method = 'GET', body } = {}) {
        const { baseUrl, masterKey } = this.encoder();
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                'X-API-Key': masterKey,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });

        const text = await res.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = { message: text };
            }
        }
        return { status: res.status, json };
    }

    // ----------------------------------------------------------------- static

    async #static(req, res, path) {
        if (!this.rendererDir) {
            return send(res, 503, {
                message: 'Renderer not built. Run: npm -w app run build',
            });
        }

        const rel = path === '/' ? 'index.html' : path.slice(1);
        // normalize + prefix check: without it, /../../etc/passwd escapes.
        const target = resolve(this.rendererDir, normalize(rel));
        const root = resolve(this.rendererDir);
        if (target !== root && !target.startsWith(root + sep)) {
            return send(res, 403, { message: 'Forbidden' });
        }

        if (existsSync(target) && statSync(target).isFile()) {
            res.writeHead(200, {
                'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
            });
            return createReadStream(target).pipe(res);
        }

        // History-mode routing: unknown paths are app routes, not missing files.
        const index = join(root, 'index.html');
        if (existsSync(index)) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            return res.end(await readFile(index));
        }
        return send(res, 404, { message: 'Not found' });
    }
}

function send(res, status, body) {
    if (body === undefined) {
        res.writeHead(status);
        return res.end();
    }
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
        return {};
    }
}
