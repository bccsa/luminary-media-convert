#!/usr/bin/env node
/**
 * Step 0 of plan 03: records the `load` payloads the TypeScript half would send
 * for a real stream, so the iOS spike plays exactly what the bridge carries.
 *
 * Runs `player-core`'s munge through the real `NativeBridgeAdapter` and
 * `NativeServeStrategy` over a recording plugin, loads the master, then visits
 * every angle (and audio-only) the way `setAngle` would. Each visit's `load`
 * arguments are kept, so the spike can replay angle switches with the
 * incremental asset sets the adapter really sends.
 *
 * Usage: node make-payload.mjs [--android] <masterUrl> <keyHex> [out.json]
 * `--android` reports Android's capabilities and writes into the Android spike's
 * assets instead of the iOS bundle.
 * Build `player-core` and `player-native` first (`npm run build:libs`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PlayerController } from '@luminary-media-converter/player-core';
import { AssetBatch } from '../dist/assetBatch.js';
import { NativeBridgeAdapter } from '../dist/NativeBridgeAdapter.js';
import { NativeServeStrategy } from '../dist/NativeServeStrategy.js';

const android = process.argv.includes('--android');
const defaultOut = android ? './android/app/src/main/assets/payload.json' : './ios/Spike/payload.json';
const [masterUrl, keyHex, out = new URL(defaultOut, import.meta.url).pathname] = process.argv
    .slice(2)
    .filter((arg) => arg !== '--android');
if (!masterUrl) {
    console.error('Usage: node make-payload.mjs [--android] <masterUrl> <keyHex> [out.json]');
    process.exit(1);
}

const loads = [];
const plugin = new Proxy(
    {
        load: async (args) => void loads.push(args),
        addListener: async () => ({ remove: async () => {} }),
    },
    { get: (target, name) => target[name] ?? (async () => {}) },
);

const info = {
    protocolVersion: 1,
    platform: android ? 'android' : 'ios',
    capabilities: {
        variantSwitching: android,
        pictureInPicture: !android,
        renderText: false,
        live: false,
        chunkWarming: false,
        backgroundAudio: false,
        maxPlayers: 1,
    },
};
const report = (method, error) => console.warn(`${method} failed`, error);
const batch = new AssetBatch();
const adapter = new NativeBridgeAdapter({ plugin, playerId: 'spike', info, batch, report });
const serveStrategy = new NativeServeStrategy({ plugin, playerId: 'spike', batch, report });
const controller = new PlayerController(adapter, { serveStrategy, prefetch: { enabled: false } });

const started = performance.now();
await controller.load({ masterUrl, ...(keyHex ? { keyHex } : {}) });
const mungeMs = Math.round(performance.now() - started);
const state = controller.getState();
if (state.lifecycle !== 'ready') {
    console.error('Load failed:', state.error);
    process.exit(1);
}

const visits = [{ angleId: state.activeAngleId, load: loads.at(-1) }];
for (const angle of state.angles) {
    if (angle.id === state.activeAngleId) continue;
    await controller.setAngle(angle.id);
    visits.push({ angleId: angle.id, load: loads.at(-1) });
}

const payload = {
    masterUrl,
    keyHex: keyHex ?? null,
    angles: state.angles,
    visits: visits.map(({ angleId, load }) => ({
        angleId,
        masterUri: load.masterUri,
        generation: load.generation,
        assets: load.assets,
    })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(payload));

console.log(`munge: ${mungeMs} ms; wrote ${out}`);
for (const { angleId, load } of visits) {
    const bytes = Buffer.byteLength(JSON.stringify(load));
    console.log(
        `  ${angleId}: ${load.assets.length} assets, ${(bytes / 1024).toFixed(0)} KiB as JSON`,
    );
}
controller.destroy();
