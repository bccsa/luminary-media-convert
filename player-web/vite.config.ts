import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js';
import { transform } from 'esbuild';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';
import { isVideoJsElement } from './src/elements';

export { isVideoJsElement };


export const vuePlugin = () => vue({ template: { compilerOptions: { isCustomElement: isVideoJsElement } } });

/**
 * Minifies the library's output.
 *
 * Vite leaves a library built as an ES module readable, on the reasoning that the app that installs it will
 * minify. That holds for code but not for a stylesheet that arrives as a string inside it, and this player's
 * own code is mostly documentation, which an app's bundler would strip anyway but a download would not.
 *
 * The cost is the `/* @__PURE__ *\/` annotations (ten of them), which no esbuild minify keeps: they tell an
 * app's bundler a top-level call can be dropped when unused, and this module is one chunk with `sideEffects`
 * declared, so an app that uses any of it takes it all either way.
 */
const minifyLibrary = (): Plugin => ({
    name: 'lmpl-minify-library',
    apply: 'build',
    enforce: 'post',
    // After every other plugin, not in `renderChunk`: Vite's own esbuild pass follows that hook and prints the
    // result again with its whitespace, which gave back most of what was saved.
    async generateBundle(_options, bundle) {
        for (const file of Object.values(bundle)) {
            if (file.type !== 'chunk') continue;
            const out = await transform(file.code, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' });
            file.code = out.code;
        }
    },
});

export default defineConfig({
    plugins: [vuePlugin(), cssInjectedByJsPlugin(), minifyLibrary()],
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
