import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AuthResolverGuard } from './auth-resolver.guard.js';
import type { SessionService, Session } from '../encode/services/session.service.js';
import type { AuthType } from './auth-types.decorator.js';

const MASTER = 'a'.repeat(64);

const getBySessionToken = vi.fn<(t: string) => Session | undefined>();
const getByReadToken = vi.fn<(t: string) => Session | undefined>();
const sessions = { getBySessionToken, getByReadToken } as unknown as SessionService;

function session(id: string): Session {
    return { id } as Session;
}

/** A request shaped the way the guard reads it, with sane empty defaults. */
function request({
    headers = {},
    query = {},
    params = {},
}: {
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    params?: Record<string, string>;
} = {}) {
    return { headers, query, params } as any;
}

function contextFor(req: any): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => undefined,
        getClass: () => undefined,
    } as unknown as ExecutionContext;
}

/**
 * Guard whose endpoint declares `allowed`; undefined means no decorator.
 *
 * Two functions rather than one with a defaulted key: passing `undefined`
 * explicitly to a defaulted parameter uses the default, so a single builder
 * could not express "this instance has no key" at all — the test asking for it
 * would have been handed the real one and passed for the wrong reason.
 */
function buildWith(allowed: AuthType[] | undefined, masterKey: string | undefined) {
    const reflector = {
        getAllAndOverride: () => allowed,
    } as unknown as Reflector;
    return new AuthResolverGuard(reflector, sessions, masterKey);
}

function build(allowed?: AuthType[]) {
    return buildWith(allowed, MASTER);
}

beforeEach(() => {
    getBySessionToken.mockReset().mockReturnValue(undefined);
    getByReadToken.mockReset().mockReturnValue(undefined);
});

describe('AuthResolverGuard — the instance token', () => {
    it('lets the app’s own UI through', async () => {
        const req = request({ headers: { 'x-api-key': MASTER } });

        await expect(build().canActivate(contextFor(req))).resolves.toBe(true);
        expect(req.authType).toBe('master');
    });

    it('is accepted on an endpoint that does not list it', async () => {
        // It is a superkey by design: the local UI holds it and drives
        // everything, so no endpoint gets to refuse it.
        const req = request({ headers: { 'x-api-key': MASTER } });

        await expect(build(['read']).canActivate(contextFor(req))).resolves.toBe(true);
    });

    it('rejects a wrong key outright instead of trying the weaker tiers', async () => {
        // A present-but-wrong key is a caller who thinks they are privileged.
        // Falling through would let a stale key quietly downgrade to read
        // access, which is worse than telling them plainly.
        const req = request({
            headers: { 'x-api-key': 'b'.repeat(64), authorization: 'Bearer sess_ok' },
        });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(['session']).canActivate(contextFor(req))).rejects.toThrow(
            UnauthorizedException,
        );
        expect(getBySessionToken).not.toHaveBeenCalled();
    });

    it('rejects a key of the wrong length without comparing it', async () => {
        // timingSafeEqual throws on a length mismatch, so the length is checked
        // first — the guard must refuse, not crash.
        const req = request({ headers: { 'x-api-key': 'short' } });

        await expect(build().canActivate(contextFor(req))).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('refuses every key when the instance has none configured', async () => {
        const req = request({ headers: { 'x-api-key': MASTER } });

        await expect(buildWith(['master'], undefined).canActivate(contextFor(req)))
            .rejects.toThrow(UnauthorizedException);
    });
});

describe('AuthResolverGuard — session tokens', () => {
    it('accepts a Bearer sess_ token where the endpoint allows it', async () => {
        const req = request({ headers: { authorization: 'Bearer sess_abc' } });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(['session']).canActivate(contextFor(req))).resolves.toBe(true);
        expect(req.authType).toBe('session');
        expect(req.session.id).toBe('s1');
    });

    it('is ignored on an endpoint that does not allow it', async () => {
        const req = request({ headers: { authorization: 'Bearer sess_abc' } });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(['master']).canActivate(contextFor(req))).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('rejects a token no session answers to', async () => {
        const req = request({ headers: { authorization: 'Bearer sess_gone' } });

        await expect(build(['session']).canActivate(contextFor(req))).rejects.toThrow(
            'Invalid or expired session token',
        );
    });

    it('refuses a valid token aimed at somebody else’s session', async () => {
        // Holding one session's token must not open another's.
        const req = request({
            headers: { authorization: 'Bearer sess_abc' },
            params: { sessionId: 's2' },
        });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(['session']).canActivate(contextFor(req))).rejects.toThrow(
            'Token does not match the requested session',
        );
    });

    it('ignores an Authorization header that is not a session token', async () => {
        const req = request({ headers: { authorization: 'Bearer read_abc' } });

        await expect(build(['session']).canActivate(contextFor(req))).rejects.toThrow(
            'No valid authentication credentials provided',
        );
    });
});

describe('AuthResolverGuard — read tokens on the query string', () => {
    it('accepts a read token where the endpoint opts in', async () => {
        // EventSource and a plain <a> cannot set headers, so a browser watching
        // a session has to carry its credential in the URL.
        const req = request({ query: { token: 'read_abc' } });
        getByReadToken.mockReturnValue(session('s1'));

        await expect(build(['read']).canActivate(contextFor(req))).resolves.toBe(true);
        expect(req.authType).toBe('read');
        expect(req.session.id).toBe('s1');
    });

    it('also accepts a session token there', async () => {
        // The UI reaches preview, waveform and storyboard from <video> and <img>
        // tags, which have the same problem.
        const req = request({ query: { token: 'sess_abc' } });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(['read']).canActivate(contextFor(req))).resolves.toBe(true);
    });

    it('is ignored on an endpoint that does not opt in', async () => {
        const req = request({ query: { token: 'read_abc' } });
        getByReadToken.mockReturnValue(session('s1'));

        await expect(build(['session']).canActivate(contextFor(req))).rejects.toThrow(
            UnauthorizedException,
        );
        expect(getByReadToken).not.toHaveBeenCalled();
    });

    it('refuses a read token aimed at another session', async () => {
        const req = request({ query: { token: 'read_abc' }, params: { sessionId: 's2' } });
        getByReadToken.mockReturnValue(session('s1'));

        await expect(build(['read']).canActivate(contextFor(req))).rejects.toThrow(
            'Invalid or expired token',
        );
    });

    it('rejects an unknown token rather than falling through', async () => {
        const req = request({ query: { token: 'read_gone' } });

        await expect(build(['read']).canActivate(contextFor(req))).rejects.toThrow(
            'Invalid or expired token',
        );
    });

    it('ignores a repeated token parameter', async () => {
        // Express gives an array for `?token=a&token=b`. Only a plain string is
        // a credential; an array must not be coerced into one.
        const req = request({ query: { token: ['read_abc', 'read_def'] } });

        await expect(build(['read']).canActivate(contextFor(req))).rejects.toThrow(
            'No valid authentication credentials provided',
        );
    });
});

describe('AuthResolverGuard — defaults', () => {
    it('requires the instance token when the endpoint declares nothing', async () => {
        const req = request({ headers: { authorization: 'Bearer sess_abc' } });
        getBySessionToken.mockReturnValue(session('s1'));

        await expect(build(undefined).canActivate(contextFor(req))).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('refuses a request carrying nothing at all', async () => {
        await expect(
            build(['master', 'session', 'read']).canActivate(contextFor(request())),
        ).rejects.toThrow('No valid authentication credentials provided');
    });
});
