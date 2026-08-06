import type { Provider } from '@nestjs/common';

/**
 * Called when a CMS opens an encoding session on this instance.
 *
 * The click that starts the work happens in a browser, on another window, and
 * everything after it happens here — the user has to choose a file. Without a
 * nudge the desktop app stays wherever it was, quite possibly behind the
 * browser, and the session sits waiting for a file nobody can see it asking
 * for. The host uses this to bring its window forward.
 *
 * Deliberately fire-and-forget: whether a window came to the front is no part
 * of whether the session was created, and the CMS must not be made to wait on
 * a window manager.
 */
export type CmsSessionHook = (sessionId: string) => void;

/** Injection token for {@link CmsSessionHook}. Undefined when nobody is listening. */
export const CMS_SESSION_HOOK = Symbol('CMS_SESSION_HOOK');

/**
 * Builds the provider for {@link CMS_SESSION_HOOK}. With no argument it
 * resolves to `undefined`, which is the standalone case: there is no window.
 */
export const createCmsSessionHookProvider = (hook?: CmsSessionHook): Provider => ({
    provide: CMS_SESSION_HOOK,
    useFactory: (): CmsSessionHook | undefined => hook,
});
