import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            'node-tusd': resolve(__dirname, '../node_modules/node-tusd/dist/index.js'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.spec.ts'],
    },
});
