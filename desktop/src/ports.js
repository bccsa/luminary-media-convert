/**
 * The renderer's port has to stay the same across launches.
 *
 * localStorage is keyed by origin, and the origin includes the port — so an
 * ephemeral port would silently discard the user's theme, their remembered
 * encode settings and every chapter draft on every restart. The encoder's port
 * can float freely, because nothing persists against it.
 *
 * The chosen port is remembered and preferred next time, so the origin only
 * changes if something else has taken it in the meantime.
 */

import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FIRST_PORT = 47800;
const ATTEMPTS = 40;

function isFree(port) {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * @param {string} statePath  JSON file under userData
 * @returns {Promise<number>}
 */
export async function stableRendererPort(statePath) {
    let remembered = null;
    if (existsSync(statePath)) {
        try {
            remembered = JSON.parse(readFileSync(statePath, 'utf-8'))?.rendererPort;
        } catch {
            remembered = null;
        }
    }

    const candidates = [
        ...(remembered ? [remembered] : []),
        ...Array.from({ length: ATTEMPTS }, (_, i) => FIRST_PORT + i),
    ];

    for (const port of candidates) {
        if (await isFree(port)) {
            if (port !== remembered) {
                mkdirSync(dirname(statePath), { recursive: true });
                writeFileSync(
                    statePath,
                    JSON.stringify({ rendererPort: port }, null, 2)
                );
            }
            return port;
        }
    }

    throw new Error(
        `No free port in ${FIRST_PORT}-${FIRST_PORT + ATTEMPTS - 1} for the app window`
    );
}
