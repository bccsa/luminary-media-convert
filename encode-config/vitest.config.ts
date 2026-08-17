import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Separate from vite.config.ts, which is the library build and has no business
// knowing about a DOM. The form's specs mount it, so the tests need jsdom.
export default defineConfig({
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        globals: false,
    },
});
