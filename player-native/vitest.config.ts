import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The TypeScript half runs against a fake plugin; nothing here needs a DOM.
        environment: 'node',
        globals: false,
        include: ['src/**/*.spec.ts', 'cast-receiver/**/*.spec.ts'],
    },
});
