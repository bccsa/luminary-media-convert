import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
    plugins: [vue()],
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
            external: ['vue'],
            output: {
                globals: { vue: 'Vue' },
            },
        },
        copyPublicDir: false,
    },
});
