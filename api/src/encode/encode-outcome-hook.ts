import type { Provider } from '@nestjs/common';

/** How an encode ended, as far as the person waiting on it is concerned. */
export interface EncodeOutcome {
    sessionId: string;
    outcome: 'completed' | 'failed';
    /** The post's title, when a CMS gave one. */
    title?: string;
    /** The source file's name, for a session no CMS named. */
    fileName?: string;
    /** With `failed`: the plain sentence the session reports. */
    message?: string;
}

/**
 * Called once an encode has finished or has failed for good.
 *
 * Long encodes run unwatched, behind other windows; the host uses this to tell
 * the person, for example with a desktop notification. A failure that will be
 * tried again by itself is not reported until the tries run out.
 *
 * Fire-and-forget, like the CMS session hook: what a host does with it is no
 * part of the encode.
 */
export type EncodeOutcomeHook = (outcome: EncodeOutcome) => void;

/** Injection token for {@link EncodeOutcomeHook}. Undefined when nobody is listening. */
export const ENCODE_OUTCOME_HOOK = Symbol('ENCODE_OUTCOME_HOOK');

/** Builds the provider for {@link ENCODE_OUTCOME_HOOK}; `undefined` standalone. */
export const createEncodeOutcomeHookProvider = (
    hook?: EncodeOutcomeHook
): Provider => ({
    provide: ENCODE_OUTCOME_HOOK,
    useFactory: (): EncodeOutcomeHook | undefined => hook,
});
