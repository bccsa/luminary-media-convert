import { defineConfig } from 'vitest/config';
import { vuePlugin } from './vite.config';

export default defineConfig({
    plugins: [vuePlugin()],
    test: {
        environment: 'jsdom',
        include: ['__tests__/**/*.test.ts'],
    },
});
