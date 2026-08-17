/**
 * Per-session bearer tokens, kept where both the list and the detail view can
 * reach them.
 *
 * The session-scoped routes (preview playlists, storyboard sprites, waveform)
 * authenticate with the session's own token rather than the UI token, because
 * EventSource and `<video>` cannot set headers and have to carry a credential
 * in the query string. `GET /api/sessions` is the only endpoint that hands
 * those tokens out, so the list populates this map and the detail view reads
 * it — refetching the list itself when opened cold, i.e. on a deep link or a
 * reload straight into a session.
 */

const tokens = new Map<string, string>();

export function setSessionToken(sessionId: string, token: string): void {
    tokens.set(sessionId, token);
}

export function getSessionToken(sessionId: string): string | undefined {
    return tokens.get(sessionId);
}

export function forgetSessionToken(sessionId: string): void {
    tokens.delete(sessionId);
}
