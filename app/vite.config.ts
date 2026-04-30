import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    plugins: [vue(), tailwindcss()],
    server: {
        port: 5173,
        strictPort: true,
    },
    resolve: {
        dedupe: ['video.js'],
    },
    test: {
        environment: 'node',
    },
});
