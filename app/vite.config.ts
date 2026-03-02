import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        dedupe: ['video.js'],
    },
    test: {
        environment: 'node',
    },
});
