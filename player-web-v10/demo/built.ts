// The player as an app gets it: mounted from the built `dist`, not from source. The demo proper loads source
// for speed, which means nothing it shows can tell a registration that tree-shaking dropped from one that works.
import { createApp, h } from 'vue';
// @ts-expect-error the built library; its declarations are emitted next to it, but this page is not type-checked
import { LuminaryPlayer } from '../dist/index.js';

const query = new URLSearchParams(location.search);
const thumbnails = query.get('thumbs') === '1';
const master = query.get('master') ?? '';

createApp({
    render: () =>
        h(LuminaryPlayer, {
            source: {
                masterUrl: master,
                ...(query.get('key') ? { keyHex: query.get('key') } : {}),
                ...(thumbnails ? { sidecars: { thumbnails: { url: new URL('thumbnails.vtt', master).href } } } : {}),
            },
        }),
}).mount('#app');
