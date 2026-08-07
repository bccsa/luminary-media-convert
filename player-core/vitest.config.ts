import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The wrapper is headless: no DOM. Anything that needs Blob/URL is
        // reached through the ServeStrategy seam and faked in tests.
        environment: 'node',
        globals: false,
        include: ['src/**/*.spec.ts'],
    },
});
