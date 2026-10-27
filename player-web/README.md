# @luminary-media-converter/player-web

The simple web player for this repo's playback stack, on **Video.js 10** (`@videojs/html` web components over
`@videojs/hlsjs-video` / hls.js). `player-core` does the munging, decryption, angle extraction, quality capping
and recovery policy; this package is the web engine binding (`HlsJsVideoAdapter`, the hls.js loaders,
`BlobServeStrategy`, `RecoveryLadder`) and a `LuminaryPlayer` Vue component on Video.js's **stock** video skin.

It serves the encoder's preview and the Luminary CMS's video preview. The Luminary app's full player (chapters,
up next, scrub roster, audio fullscreen, its own skin) lives in the Luminary repo and runs on this package's
engine.

It plays LMCENC-encrypted playlists and sidecars, the `luminary://key` sentinel (served to hls.js from memory),
live playlists, byte-range chunk chains and multi-angle masters. YouTube is **not** supported.

## Using it

```vue
<LuminaryPlayer :source="source" :controls="{ windowedControls: false }" windowed-fit="cover" />
```

Props: `source`, `messages`, `lang`, `controls` (`audioMenu`, `subtitlesMenu`, `windowedControls`), `windowedFit`,
`controllerOptions`, `createController`. Events: `timeupdate`, `loadedmetadata`, `ended`. Slots: default,
`coming-soon`, `error` (`{ error, retry }`). Exposed: `controller`, `state`, `enterFullscreen`, `exitFullscreen`,
`seek`, `play`, `pause`.

`windowedControls: false` gives a bare windowed frame: the skin is `inert`, so nothing takes a click, focus or a
key, and a double-click toggles fullscreen. Fullscreen shows the stock controls.

**A consumer that compiles this package's source** must leave Video.js 10's elements to the browser:

```ts
import { isVideoJsElement } from '@luminary-media-converter/player-web';
vue({ template: { compilerOptions: { isCustomElement: isVideoJsElement } } });
```

Under jsdom, tests that import the player need `CSSStyleSheet.prototype.replaceSync` stubbed: the stock skin
builds its shadow stylesheet with it on import.

## Development

```bash
npm -w player-web run build       # dist/index.js + declarations
npm -w player-web run dev         # watch build
npm -w player-web run demo        # http://localhost:5182 (?master=<url>&key=<hex>)
npm -w player-web run test        # unit tests
npm -w player-web run test:e2e    # Playwright, Chromium + WebKit, own fixture server
```
