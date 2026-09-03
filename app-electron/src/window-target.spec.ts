import { describe, expect, it } from 'vitest';
import { resolveWindowTarget } from './window-target';

const SERVER = 'http://127.0.0.1:31711';

describe('resolveWindowTarget', () => {
    describe('packaged', () => {
        it('points a window at the API that serves the renderer', () => {
            expect(
                resolveWindowTarget({ isPackaged: true, serverUrl: SERVER })
            ).toBe(SERVER);
        });

        it('has no target before the server is listening', () => {
            // The case that crashed the main process: a CMS protocol link
            // launches the app, so `open-url` fires as soon as Electron is
            // ready — seconds before the Nest server has finished booting.
            expect(resolveWindowTarget({ isPackaged: true })).toBeUndefined();
        });

        it('ignores the dev renderer, which is not running in a release', () => {
            expect(
                resolveWindowTarget({
                    isPackaged: true,
                    devRendererUrl: 'http://localhost:5173',
                })
            ).toBeUndefined();
        });
    });

    describe('development', () => {
        it('uses the renderer URL the harness names', () => {
            expect(
                resolveWindowTarget({
                    isPackaged: false,
                    devRendererUrl: 'http://localhost:4000',
                })
            ).toBe('http://localhost:4000');
        });

        it("falls back to Vite's default port when nothing names one", () => {
            expect(resolveWindowTarget({ isPackaged: false })).toBe(
                'http://localhost:5173'
            );
        });

        it('does not wait for the API, which dev runs separately', () => {
            expect(resolveWindowTarget({ isPackaged: false })).toBeDefined();
        });
    });
});
