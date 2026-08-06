import { SetMetadata } from '@nestjs/common';

/**
 * Which credentials an endpoint accepts.
 *
 * - `instance` — the instance API token, on `X-API-Key`. The app's own UI, and
 *   a superkey: the guard accepts it wherever it appears, whatever an endpoint
 *   declares. Named for what it is scoped to, one running instance; it was
 *   `master`, which carried multi-tenant connotations from a product that no
 *   longer exists.
 * - `session` — the Bearer token that drives one session.
 * - `read` — the session's read-only token, on `?token=`. Watching only:
 *   granted to the CMS, which follows a session it is not allowed to change.
 */
export type AuthType = 'instance' | 'session' | 'read';
export const AUTH_TYPES_KEY = 'authTypes';
export const AuthTypes = (...types: AuthType[]) => SetMetadata(AUTH_TYPES_KEY, types);
