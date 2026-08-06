import type { Provider } from '@nestjs/common';

/**
 * Injection token for the single API token this local instance accepts on the
 * `X-API-Key` header. Injected rather than read from the environment so an
 * embedding host — a future `createServer(opts)` bootstrap — can hand the API
 * a token it generated in-process instead of exporting one to the environment.
 */
export const LOCAL_API_TOKEN = Symbol('LOCAL_API_TOKEN');

/** The value bound to {@link LOCAL_API_TOKEN}. Undefined disables key auth. */
export type LocalApiToken = string | undefined;

/**
 * Builds the provider for {@link LOCAL_API_TOKEN}. With no argument the token
 * is read from `MASTER_API_KEY` at module-init time (so `dotenv` has already
 * run); pass a value to override it.
 */
export const createLocalApiTokenProvider = (token?: LocalApiToken): Provider => ({
    provide: LOCAL_API_TOKEN,
    useFactory: (): LocalApiToken => token ?? process.env.MASTER_API_KEY,
});
