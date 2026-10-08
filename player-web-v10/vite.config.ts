import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { resolve } from 'node:path';

/**
 * Video.js 10's elements are custom elements, so the compiler must leave them alone. Doing it here
 * means the compiled library carries no compile-time dependency on the consumer's config.
 */
export const isVideoJsElement = (tag: string): boolean =>
    tag === 'video-player' || tag === 'video-skin' || tag === 'hlsjs-video' || tag.startsWith('media-');

export const vuePlugin = () => vue({ template: { compilerOptions: { isCustomElement: isVideoJsElement } } });

export default defineConfig({
    plugins: [vuePlugin(), cssInjectedByJsPlugin()],
    build: {
        // The dev script runs vue-tsc alongside this, writing .d.ts into the same directory.
        emptyOutDir: !process.argv.includes('--watch'),
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            external: [
                'vue',
                /^@videojs\//,
                'hls.js',
                'iso-639-2',
                '@luminary-media-converter/player-core',
            ],
            output: { globals: { vue: 'Vue' } },
        },
        copyPublicDir: false,
    },
});
