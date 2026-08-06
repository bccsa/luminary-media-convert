import { SetMetadata } from '@nestjs/common';

/**
 * - `master` — the instance API token, on `X-API-Key`. The local UI.
 * - `session` — the Bearer token that drives one session.
 * - `read` — the session's read-only token, on `?token=`. Watching only:
 *   granted to the CMS, which follows a session it is not allowed to change.
 */
export type AuthType = 'master' | 'session' | 'read';
export const AUTH_TYPES_KEY = 'authTypes';
export const AuthTypes = (...types: AuthType[]) => SetMetadata(AUTH_TYPES_KEY, types);
