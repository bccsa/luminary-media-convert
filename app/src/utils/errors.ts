/** Normalize an unknown thrown value into a display string. */
export function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
