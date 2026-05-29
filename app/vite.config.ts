import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
    plugins: [
        vue(),
        tailwindcss(),
        VitePWA({
            registerType: 'prompt',
            includeAssets: ['favicon.svg', 'favicon.ico'],
            manifest: {
                name: 'Luminary Media Convert',
                short_name: 'Luminary',
                description: 'Upload, encode, and review media sessions.',
                theme_color: '#0284c7',
                background_color: '#f8fafc',
                display: 'standalone',
                scope: '/',
                start_url: '/sessions',
                icons: [
                    {
                        src: 'pwa-64x64.png',
                        sizes: '64x64',
                        type: 'image/png',
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any',
                    },
                    {
                        src: 'maskable-icon-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable',
                    },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                navigateFallback: 'index.html',
                navigateFallbackDenylist: [/^\/api\//],
            },
            devOptions: {
                enabled: false,
            },
        }),
        cloudflare(),
    ],
    server: {
        port: 5173,
        strictPort: true,
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        },
    },
    resolve: {
        dedupe: ['video.js'],
    },
    test: {
        environment: 'node',
    },
});
