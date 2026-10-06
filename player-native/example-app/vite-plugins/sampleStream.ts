import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Serves a stream directory at `mount`, with `Range`, the way a CDN serves byte-range chunk
 * chains: the sample stream `player-native/spike/make-sample-stream.py` builds at `/sample/`, and
 * the live one `scripts/live-stream.sh` keeps writing at `/live/`. Playlists are never cached, as
 * a live one must not be. A phone on the LAN reaches both through the dev server's network address.
 */
export function sampleStream(directory: string, mount = '/sample'): Plugin {
    const types: Record<string, string> = {
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.mp4': 'video/mp4',
        '.m4s': 'video/iso.segment',
        '.ts': 'video/mp2t',
    };

    return {
        name: `stream${mount}`,
        configureServer(server) {
            server.middlewares.use(mount, (req, res, next) => {
                const relative = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
                const file = path.join(directory, relative);
                if (!file.startsWith(directory) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                    next();
                    return;
                }
                const size = fs.statSync(file).size;
                res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
                res.setHeader('Accept-Ranges', 'bytes');
                if (path.extname(file) === '.m3u8') res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Headers', 'Range');
                res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
                const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
                if (!range) {
                    res.setHeader('Content-Length', size);
                    fs.createReadStream(file).pipe(res);
                    return;
                }
                const start = Number(range[1]);
                const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
                if (start > end) {
                    res.statusCode = 416;
                    res.end();
                    return;
                }
                res.statusCode = 206;
                res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
                res.setHeader('Content-Length', end - start + 1);
                fs.createReadStream(file, { start, end }).pipe(res);
            });
        },
    };
}
