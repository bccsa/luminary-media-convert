import { Logger } from '@nestjs/common';

/**
 * The token browser development uses when nothing supplies one.
 *
 * `app/src/auth-token.ts` falls back to the same literal, and the two have to
 * agree or the UI is refused by the API it is paired with. It is deliberately
 * an obvious non-secret: anyone reading a network tab in dev should recognise
 * it as a placeholder rather than wonder whether they have leaked something.
 */
export const DEV_API_TOKEN = 'dev-token';

/**
 * Origins browser development runs on: the Vite client and the CMS mock.
 *
 * The mock is on a different port on purpose, so the real CORS and origin
 * gating path is exercised — which also means an empty allowlist refuses it,
 * and standalone there is no approver to ask.
 */
const DEV_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5199',
    'http://127.0.0.1:5199',
];

/**
 * Fills in what browser development needs so a fresh clone runs without a
 * hand-copied `.env`.
 *
 * Three things failed without one, and only one of them announced itself: the
 * UI threw for a missing token, the client called its own Vite origin instead
 * of the API, and the origin allowlist — empty, with no approver standalone —
 * refused both the client and the CMS mock. The third is the least obvious,
 * because the web client being a cross-origin page like any other is only true
 * in browser dev.
 *
 * Only ever fills gaps: anything already in the environment wins, so `.env`
 * goes back to being for overrides rather than for the minimum.
 *
 * **Not applied in production**, and it says so out loud when it applies at
 * all. A silent gate would be the more dangerous design here — a dev token that
 * quietly worked in a real deployment is exactly the outcome worth being noisy
 * about, and the log line is the only thing that distinguishes "configured" from
 * "defaulted" at a glance.
 *
 * The desktop app never reaches this: it hands `createServer()` a token minted
 * per launch and an origin policy with a real approver, and does not run this
 * entry point at all.
 */
export function applyDevDefaults(logger = new Logger('DevDefaults')): void {
    if (process.env.NODE_ENV === 'production') return;

    const applied: string[] = [];

    if (!process.env.LOCAL_API_TOKEN && !process.env.MASTER_API_KEY) {
        process.env.LOCAL_API_TOKEN = DEV_API_TOKEN;
        applied.push(`LOCAL_API_TOKEN=${DEV_API_TOKEN}`);
    }

    if (!process.env.CMS_ALLOWED_ORIGINS) {
        process.env.CMS_ALLOWED_ORIGINS = DEV_ORIGINS.join(',');
        applied.push('CMS_ALLOWED_ORIGINS=<localhost 5173 + 5199>');
    }

    if (applied.length === 0) return;

    logger.warn(
        `Development defaults applied (${applied.join(', ')}). ` +
            'Set these in api/.env to override, and never run this way in ' +
            'production — NODE_ENV=production disables them entirely.'
    );
}
