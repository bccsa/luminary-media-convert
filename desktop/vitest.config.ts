import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // Node, not jsdom: this workspace is the Electron main process.
        environment: 'node',
        include: ['src/**/*.spec.js'],
    },
});
