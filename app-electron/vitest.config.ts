import { defineConfig } from 'vitest/config';

/**
 * Only the modules that can run outside Electron are tested here. Anything
 * reaching for `app`, `BrowserWindow` or `dialog` needs a real Electron
 * process, so the logic worth asserting on is kept in plain modules that take
 * what they need as arguments — see ffmpeg-location.ts.
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.spec.ts'],
    },
});
