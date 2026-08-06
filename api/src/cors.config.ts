import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NextFunction, Request, Response } from 'express';
import type { OriginRegistry } from './cms/origin-registry.js';

/**
 * Response headers the browser is allowed to hand to JavaScript.
 *
 * Only the safelisted headers are readable across origins by default. Anything
 * custom has to be named here or `response.headers.get(...)` simply returns
 * null — the header arrives, and the client cannot see it.
 *
 * That is a silent failure, and it has already cost once: the storyboard
 * endpoint reports completion in `X-Storyboard-Complete`, the header was sent
 * but not exposed, so the client never learned that sampling had finished. It
 * left "Generating thumbnails…" on screen and kept polling for the life of the
 * page, with nothing logged anywhere to say why.
 *
 * Anything the web client reads off a response belongs in this list.
 */
export const EXPOSED_HEADERS = [
    // Storyboard sampling is finished; the timeline stops polling and drops its
    // "generating" badge.
    'X-Storyboard-Complete',
];

/**
 * CORS for the Encoding API, minus the origin decision.
 *
 * The service is token-authenticated — `X-API-Key` or a Bearer session token,
 * never cookies — so nothing here rides on ambient credentials. The origin is
 * still gated (see {@link createCorsOptions}) because this build listens on a
 * user's own loopback interface, where "any origin" means any page they happen
 * to have open.
 */
export const CORS_OPTIONS: CorsOptions = {
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
};

/**
 * CORS options bound to the instance's origin policy.
 *
 * Requests with no `Origin` are allowed: curl, same-origin navigation, and the
 * Electron renderer — whose origin is `file://` or a custom app scheme, and
 * which the browser may send as `null` or omit entirely. Those callers are
 * already inside the trust boundary; a page in someone's browser is not, and
 * has to be on the allowlist or granted by the approver.
 *
 * Refusal is expressed by withholding the header rather than raising, so the
 * browser reports an ordinary CORS block instead of the API returning 500 to
 * something it deliberately turned away.
 */
export const createCorsOptions = (registry: OriginRegistry): CorsOptions => ({
    ...CORS_OPTIONS,
    origin: (origin, callback) => {
        if (!origin || origin === 'null') {
            callback(null, true);
            return;
        }
        // The call is made *inside* the chain, not handed to Promise.resolve
        // ready-made. `isAllowed` has a synchronous return path and invokes the
        // host's approver directly, so it can throw before any promise exists —
        // and such a throw would escape this callback and become a 500 from a
        // request we meant to quietly turn away, which is the one outcome this
        // function exists to avoid.
        void Promise.resolve()
            .then(() => registry.isAllowed(origin))
            .then(
                (allowed) => callback(null, allowed),
                () => callback(null, false),
            );
    },
});

/**
 * Answers Chrome's Local Network Access preflight.
 *
 * A public web app reaching 127.0.0.1 is a private-network request: Chrome
 * sends `Access-Control-Request-Private-Network: true` on the preflight and
 * drops the real request unless the response grants it, whatever the rest of
 * CORS says. Registered ahead of the CORS middleware, which is what ends the
 * preflight response.
 *
 * Only a grant of reachability — who may actually talk to the API is still the
 * origin allowlist's decision, applied by the CORS layer on the same response.
 */
export const privateNetworkAccessMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
): void => {
    if (
        req.method === 'OPTIONS' &&
        req.headers['access-control-request-private-network'] === 'true'
    ) {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
};
