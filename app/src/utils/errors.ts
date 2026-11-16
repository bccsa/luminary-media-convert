/** Normalize an unknown thrown value into a display string. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * A refusal from the API, carrying the HTTP status and, on a 409, the `code`
 * that says which conflict it was.
 *
 * Here rather than in `api.ts` so a caller can test for it without importing
 * the fetch client — the specs replace that module wholesale, and an export it
 * leaves out throws when read.
 */
export class ApiError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Luminary CMS has not stored the video's current version, or is not
 * following the session: the encoder refused the save or job and wrote
 * nothing.
 */
export const CMS_NOT_ACKNOWLEDGED = 'CMS_NOT_ACKNOWLEDGED';
/**
 * Another machine wrote the next version first. The session has moved on to
 * the newest one; the edit here can be saved again over it.
 */
export const CHANGED_ELSEWHERE = 'CHANGED_ELSEWHERE';

/** By the Save or Start button the CMS refusal came back from. */
export const CMS_NOT_STORED_WARNING =
    "Luminary CMS hasn't stored the current version of this video. Open the post in Luminary CMS, save it if it has unsaved changes, then save again here.";

/** The banner over the player while a saved version waits for the CMS. */
export const CMS_PENDING_NOTICE =
    'Saved. Waiting for Luminary CMS to store it — open the post in Luminary CMS.';

/** The conflict code of an API refusal, when it named one. */
export function errorCode(e: unknown): string | undefined {
    return e instanceof ApiError ? e.code : undefined;
}

export function isChangedElsewhere(e: unknown): boolean {
    return errorCode(e) === CHANGED_ELSEWHERE;
}

/**
 * What a refused save or job start shows by its button. The CMS refusal is
 * reworded: the encoder's message is written for whoever reads its logs, and
 * the person here needs to know what to do in the CMS.
 */
export function saveErrorMessage(e: unknown): string {
    return errorCode(e) === CMS_NOT_ACKNOWLEDGED
        ? CMS_NOT_STORED_WARNING
        : errorMessage(e);
}
