import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * Dev server for the test harness in `demo/` — a page that plays any master
 * URL (plus optional session key) through the real LuminaryPlayer.
 *
 * The workspace libraries are aliased to their SOURCE entry points, so the
 * harness needs no build step and always reflects the working tree; the
 * library build config above it stays untouched.
 */
export default defineConfig({
    root: resolve(__dirname, 'demo'),
    plugins: [vue()],
    resolve: {
        alias: {
            '@luminary-media-converter/player-core': resolve(
                __dirname,
                '../player-core/src/index.ts'
            ),
            '@luminary-media-converter/hls-core': resolve(
                __dirname,
                '../hls-core/src/index.ts'
            ),
        },
        dedupe: ['vue'],
    },
    server: {
        port: 5182,
        strictPort: true,
    },
});
