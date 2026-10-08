import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve } from 'node:path';

export default defineConfig({
    plugins: [vue(), cssInjectedByJsPlugin()],
    build: {
        // The dev script runs vue-tsc alongside this, writing .d.ts
        // into the same directory; emptying it would take them with it.
        emptyOutDir: !process.argv.includes('--watch'),
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            external: [
                'vue',
                'video.js',
                'videojs-mobile-ui',
                'videojs-youtube',
                'iso-639-2',
                '@luminary-media-converter/player-core',
            ],
            output: {
                globals: { vue: 'Vue' },
            },
        },
        copyPublicDir: false,
    },
});
