import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

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
    'Location',
    // Tus protocol — resumable uploads read these to resume and finish.
    'Tus-Resumable',
    'Tus-Version',
    'Tus-Extension',
    'Tus-Max-Size',
    'Upload-Length',
    'Upload-Offset',
    'Upload-Metadata',
    // Storyboard sampling is finished; the timeline stops polling and drops its
    // "generating" badge.
    'X-Storyboard-Complete',
];

/**
 * CORS for the Encoding API.
 *
 * A public, token-authenticated service — `X-API-Key` or a Bearer session
 * token, never cookies or ambient credentials — so any origin is safe, the same
 * pattern Stripe and GitHub use for bearer-auth APIs.
 *
 * `/api/tus` routes are raw Express handlers proxied to the tusd Go binary,
 * which writes its own CORS headers; those take precedence over these.
 */
export const CORS_OPTIONS: CorsOptions = {
    origin: true,
    credentials: false,
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-API-Key',
        // Tus protocol headers — required for resumable uploads via /api/tus
        'Tus-Resumable',
        'Upload-Length',
        'Upload-Offset',
        'Upload-Metadata',
        'Upload-Defer-Length',
        'Upload-Concat',
    ],
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
};
