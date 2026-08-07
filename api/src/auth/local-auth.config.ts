import { Logger, type Provider } from '@nestjs/common';

/**
 * Injection token for the single API token this local instance accepts on the
 * `X-API-Key` header. Injected rather than read from the environment so an
 * embedding host — `createServer(opts)` — can hand the API a token it generated
 * in-process instead of exporting one to the environment.
 */
export const LOCAL_API_TOKEN = Symbol('LOCAL_API_TOKEN');

/** The value bound to {@link LOCAL_API_TOKEN}. Undefined disables key auth. */
export type LocalApiToken = string | undefined;

const logger = new Logger('LocalApiToken');

/**
 * Builds the provider for {@link LOCAL_API_TOKEN}.
 *
 * With no argument the token comes from the environment at module-init time, so
 * `dotenv` has already run; pass a value to override it, which is what the
 * desktop host does with the token it mints per launch.
 *
 * `LOCAL_API_TOKEN` is the name, matching the injection token and the tier the
 * guard calls `instance`. `MASTER_API_KEY` is still read, because it is what
 * every existing `.env` and deployment says and silently ignoring it would look
 * like the API had stopped accepting a key that is right there in the file. It
 * warns, so the deprecation is visible rather than permanent.
 */
export const createLocalApiTokenProvider = (
    token?: LocalApiToken
): Provider => ({
    provide: LOCAL_API_TOKEN,
    useFactory: (): LocalApiToken => {
        if (token) return token;

        const current = process.env.LOCAL_API_TOKEN;
        if (current) return current;

        const legacy = process.env.MASTER_API_KEY;
        if (legacy) {
            logger.warn(
                'MASTER_API_KEY is deprecated — rename it to LOCAL_API_TOKEN. ' +
                    'It is one token scoped to this instance, not a key over ' +
                    "other people's data."
            );
            return legacy;
        }

        // No token at all means the guard accepts everything. That is a
        // legitimate configuration — it is how the API runs before anyone has
        // set one — but it is indistinguishable at runtime from a working
        // instance, so it says so rather than leaving the security model
        // switched off in silence.
        logger.warn(
            'No LOCAL_API_TOKEN configured — key authentication is DISABLED and ' +
                'every request to this instance is accepted. Set LOCAL_API_TOKEN ' +
                'to turn it on.'
        );
        return undefined;
    },
});
