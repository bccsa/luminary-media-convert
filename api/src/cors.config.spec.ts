import { CORS_OPTIONS, EXPOSED_HEADERS } from './cors.config.js';

/**
 * A custom response header is invisible to cross-origin JavaScript unless CORS
 * names it. The header still arrives, `headers.get()` just returns null — so
 * the client behaves as though the server never said anything, and nothing is
 * logged on either side.
 *
 * That is what happened to the storyboard's completion flag: sent by the API,
 * unreadable by the browser, so the timeline never learned sampling had ended.
 * It kept "Generating thumbnails…" on screen and polled for the life of the
 * page. These tests exist so the next header does not fail the same way.
 */
describe('CORS configuration', () => {
    it('exposes the storyboard completion header', () => {
        // Read by useStoryboard to stop polling and clear the badge.
        expect(EXPOSED_HEADERS).toContain('X-Storyboard-Complete');
    });

    it('exposes the tus headers a resumable upload depends on', () => {
        for (const header of [
            'Location',
            'Tus-Resumable',
            'Upload-Offset',
            'Upload-Length',
        ]) {
            expect(EXPOSED_HEADERS).toContain(header);
        }
    });

    it('accepts the auth headers the client sends', () => {
        expect(CORS_OPTIONS.allowedHeaders).toContain('X-API-Key');
        expect(CORS_OPTIONS.allowedHeaders).toContain('Authorization');
    });

    it('allows any origin without credentials', () => {
        // Token-authenticated, never cookies — so an open origin carries no
        // ambient authority to abuse.
        expect(CORS_OPTIONS.origin).toBe(true);
        expect(CORS_OPTIONS.credentials).toBe(false);
    });

    it('hands the exposed list to the server unchanged', () => {
        // The list is the contract; wiring it to something else would make
        // every test above decorative.
        expect(CORS_OPTIONS.exposedHeaders).toBe(EXPOSED_HEADERS);
    });
});
