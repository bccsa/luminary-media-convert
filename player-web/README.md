# @luminary-media-converter/player-web

The web player for this repo's playback stack, on **Video.js 10** (`@videojs/html` web components over
`@videojs/hlsjs-video` / hls.js). `player-core` does the munging, decryption, angle extraction, quality capping
and recovery policy; this package is the web engine binding (`HlsJsVideoAdapter`) and the `LuminaryPlayer`
Vue component.

It plays LMCENC-encrypted playlists and sidecars, the `luminary://key` sentinel (served to hls.js from memory),
live playlists, byte-range chunk chains and multi-angle masters. YouTube is **not** supported here; it lives in
the frozen `player-web-v8`.

## Using it

```vue
<LuminaryPlayer :controller-options="{ serveStrategy }" :controls="{ windowedControls: false }" windowed-fit="cover" />
```

Props: `source`, `messages`, `controls`, `windowedFit`, `poster`, `preferredLanguage`, `controllerOptions`,
`createController`. Exposed: `controller`, `state`, `enterFullscreen`, `exitFullscreen`, `seek`, `play`, `pause`.

**A consumer that compiles this package's source** (an alias to `src/index.ts`, as the Luminary app's submodule
install and `player-native/example-app` do) must leave Video.js 10's elements to the browser:

```ts
import { isVideoJsElement } from '@luminary-media-converter/player-web';
vue({ template: { compilerOptions: { isCustomElement: isVideoJsElement } } });
```

A consumer of the built `dist/` needs nothing. `dist` is not tree-shaken away because the package declares
`ui/register.ts` in `sideEffects`; it registers the custom elements.

## Development

```bash
npm -w player-web run build       # dist/index.js + declarations (builds the skin stylesheet first)
npm -w player-web run dev         # watch build
npm -w player-web run demo        # http://localhost:5182 (?master=<url>&key=<hex>&thumbs=<vtt>)
npm -w player-web run test        # unit tests
npm -w player-web run test:e2e    # Playwright, Chromium + WebKit, own fixture server
```

`demo/compare.html` shows this player beside the v8 one (start `npm -w player-web-v8 run demo` for port 5183).
`ENGINE=v8` runs the shared e2e specs against the old player.
