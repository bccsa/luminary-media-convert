import { networkInterfaces } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { buildTargetVirtuals } from './vite-plugins/buildTargetVirtuals';
import { sampleStream } from './vite-plugins/sampleStream';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * A packaged app loads from `https://localhost`, so the sample stream is reached through this
 * machine's LAN address and the dev server's port. `VITE_LAB_ORIGIN` overrides it.
 */
function lanOrigin(): string | undefined {
    const address = Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
    return address ? `http://${address}:5190` : undefined;
}
if (process.env.VITE_NATIVE_IMPL_DIR && !process.env.VITE_LAB_ORIGIN) {
    const origin = lanOrigin();
    if (origin) process.env.VITE_LAB_ORIGIN = origin;
}

/**
 * The workspace libraries resolve to their source, as `player-web`'s demo does: the lab needs no
 * build step and always reflects the working tree.
 */
export default defineConfig({
    plugins: [
        vue(),
        buildTargetVirtuals(),
        sampleStream(at('../spike/android/app/src/main/assets/stream')),
    ],
    resolve: {
        alias: {
            '@': at('./src'),
            '@luminary-media-converter/player-core': at('../../player-core/src/index.ts'),
            '@luminary-media-converter/hls-core': at('../../hls-core/src/index.ts'),
            '@luminary-media-converter/player-web': at('../../player-web/src/index.ts'),
            '@luminary-media-converter/player-native': at('../src/index.ts'),
        },
        dedupe: ['vue'],
    },
    server: {
        port: 5190,
        strictPort: true,
        // A phone on the LAN reaches the dev server, and the sample stream, by this machine's address.
        host: true,
    },
});
