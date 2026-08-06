import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
    CORS_OPTIONS,
    EXPOSED_HEADERS,
    createCorsOptions,
    privateNetworkAccessMiddleware,
} from './cors.config.js';
import type { OriginRegistry } from './cms/origin-registry.js';

/** Invoke the `origin` callback and resolve to what it decided. */
function decide(
    options: ReturnType<typeof createCorsOptions>,
    origin: string | undefined
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const fn = options.origin as (
            origin: string | undefined,
            cb: (err: Error | null, allow?: boolean) => void
        ) => void;
        fn(origin, (err, allow) =>
            err ? reject(err) : resolve(allow === true)
        );
    });
}

function registryAllowing(
    isAllowed: (origin: string) => boolean | Promise<boolean>
): OriginRegistry {
    return { isAllowed: vi.fn(isAllowed) } as unknown as OriginRegistry;
}

describe('CORS — static options', () => {
    it('sends no ambient credentials', () => {
        // Every route is token-authenticated, so nothing should ride on cookies
        // — and `credentials: true` with a permissive origin is how a local
        // service gets driven by any page the user happens to have open.
        expect(CORS_OPTIONS.credentials).toBe(false);
    });

    it('allows the headers the client actually sends', () => {
        expect(CORS_OPTIONS.allowedHeaders).toEqual(
            expect.arrayContaining([
                'Content-Type',
                'Authorization',
                'X-API-Key',
            ])
        );
    });

    it('exposes X-Storyboard-Complete to the client', () => {
        // Unexposed, `response.headers.get()` silently returns null: the header
        // arrives and the client cannot see it. That failure already cost once,
        // leaving "Generating thumbnails…" on screen for the life of the page.
        expect(EXPOSED_HEADERS).toContain('X-Storyboard-Complete');
        expect(CORS_OPTIONS.exposedHeaders).toBe(EXPOSED_HEADERS);
    });
});

describe('CORS — the origin decision', () => {
    it('asks the registry about a browser origin', async () => {
        const registry = registryAllowing((o) => o === 'http://localhost:5199');
        const options = createCorsOptions(registry);

        await expect(decide(options, 'http://localhost:5199')).resolves.toBe(
            true
        );
        await expect(decide(options, 'https://evil.example')).resolves.toBe(
            false
        );
    });

    it('waits on an approval the registry has to ask a human for', async () => {
        // Trust on first use puts a native dialog in front of the user; the
        // decision is a promise and the answer has to be awaited, not assumed.
        const registry = registryAllowing(
            async (o) => o === 'https://cms.example.com'
        );
        const options = createCorsOptions(registry);

        await expect(decide(options, 'https://cms.example.com')).resolves.toBe(
            true
        );
        await expect(decide(options, 'https://other.example')).resolves.toBe(
            false
        );
    });

    it.each([undefined, 'null'])(
        'allows a request whose origin is %o',
        async (origin) => {
            // curl, same-origin navigation, and the Electron renderer — whose origin
            // browsers report inconsistently. These are already inside the trust
            // boundary; the CMS route separately refuses an origin-less request that
            // did not come from a loopback peer.
            const registry = registryAllowing(() => false);

            await expect(
                decide(createCorsOptions(registry), origin)
            ).resolves.toBe(true);
        }
    );

    it('does not consult the registry for those', async () => {
        const registry = registryAllowing(() => false);

        await decide(createCorsOptions(registry), undefined);

        expect(registry.isAllowed).not.toHaveBeenCalled();
    });

    it('refuses by withholding the header, never by raising', async () => {
        // The browser should report an ordinary CORS block. A rejection here
        // would surface as a 500 from a request the API deliberately turned away.
        const registry = registryAllowing(() => {
            throw new Error('registry exploded');
        });

        await expect(
            decide(createCorsOptions(registry), 'https://x.example')
        ).resolves.toBe(false);
    });

    it('treats a rejected approval as a refusal', async () => {
        const registry = registryAllowing(() =>
            Promise.reject(new Error('dialog failed'))
        );

        await expect(
            decide(createCorsOptions(registry), 'https://x.example')
        ).resolves.toBe(false);
    });

    it('keeps the static options alongside the origin decision', () => {
        const options = createCorsOptions(registryAllowing(() => true));

        expect(options.credentials).toBe(false);
        expect(options.exposedHeaders).toBe(EXPOSED_HEADERS);
        expect(options.maxAge).toBe(CORS_OPTIONS.maxAge);
    });
});

describe('Private Network Access preflight', () => {
    function run(method: string, headers: Record<string, string>) {
        const setHeader = vi.fn();
        const next = vi.fn();
        privateNetworkAccessMiddleware(
            { method, headers } as unknown as Request,
            { setHeader } as unknown as Response,
            next as unknown as NextFunction
        );
        return { setHeader, next };
    }

    it('grants the private-network preflight Chrome sends', () => {
        // Without this, Chrome drops the real request whatever the rest of CORS
        // says — a public page reaching 127.0.0.1 is a private-network request.
        const { setHeader, next } = run('OPTIONS', {
            'access-control-request-private-network': 'true',
        });

        expect(setHeader).toHaveBeenCalledWith(
            'Access-Control-Allow-Private-Network',
            'true'
        );
        expect(next).toHaveBeenCalled();
    });

    it('stays out of the way of an ordinary preflight', () => {
        const { setHeader, next } = run('OPTIONS', {});

        expect(setHeader).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('ignores the header on a real request', () => {
        const { setHeader } = run('GET', {
            'access-control-request-private-network': 'true',
        });

        expect(setHeader).not.toHaveBeenCalled();
    });

    it('grants reachability only — it does not decide who may talk', () => {
        // The allowlist is still applied by the CORS layer on the same response.
        const { setHeader } = run('OPTIONS', {
            'access-control-request-private-network': 'true',
        });

        const granted = setHeader.mock.calls.map(([name]) => name);
        expect(granted).toEqual(['Access-Control-Allow-Private-Network']);
    });

    it('always calls next', () => {
        expect(run('POST', {}).next).toHaveBeenCalled();
    });
});
