# player-web/ — Video.js 10 web player

## Overview

- **`player-web/`** — The web implementation of the player, on Video.js 10 (`@videojs/html` web components, `@videojs/hlsjs-video` over hls.js): `HlsJsVideoAdapter` over `player-core`'s `PlayerAdapter` contract, and `LuminaryPlayer.vue`. The controls are a static markup layout (`ui/controlsHtml.ts`) styled by `styles.css` on top of a purged copy of the Video.js skin stylesheet (`scripts/build-skin-css.mjs` → gitignored `src/generated/skin.css`), and only the elements and icons it uses are registered (`ui/register.ts`, which is why the package declares it in `sideEffects`). The controls show in every mode by default; `controls.windowedControls: false` gives a **bare windowed frame** for a host that drives playback from its own interface — no control bar, big play button or menus while windowed, a click does nothing and a double-click toggles fullscreen; fullscreen shows every control. `windowedFit` (`'contain'` default, `'cover'`) sets the picture's `object-fit` while windowed, because the inner `<video>` sits in a shadow root host CSS cannot reach. There is no audio/video toggle in the player and no YouTube mode — YouTube is only in the frozen `player-web-v8`. The controls: centre play with skip buttons, a thick timeline with scrub thumbnails (`player-core`'s `thumbnailAt`), and under it the volume, speed, language, quality and captions cards (language only when there is more than one), with cast/AirPlay/PiP/fullscreen to the right. `--lmpl-s` scales margins and type for desktop fullscreen. The hls.js request seam (`adapter/hlsLoaders.ts`) answers `luminary://key` from memory and live playlists (`luminary://live/<n>`), and gives byte-range segment requests a long time-to-first-byte (a cold chunk object is not a reason to switch down — all renditions share the object); stall detection is hls.js's own errors (`hlsStallSignals.ts`) feeding the adapter's `RecoveryLadder`. The `poster` is the component's own `<img>` (`PlayerImage`: `{ srcset?, sizes?, src?, fallback? }`, or a URL). Consumers that compile this package's source must pass `isVideoJsElement` to Vue's `isCustomElement`. Dev harness: `npm -w player-web run demo` (port 5182; `demo/compare.html` shows it beside the v8 player on 5183, `demo/built.html` runs the built library); Playwright e2e (`npm -w player-web run test:e2e`, Chromium + WebKit, own fixture server) covers playback, controls and the built bundle. Published as `@luminary-media-converter/player-web`; consumed by `app/`, and by the Luminary app via a git-submodule checkout plus a file-reference install.

## Files

```
player-web/src/{index,elements,controls,image,messages,youtube,styles.css}
player-web/src/{adapter/{HlsJsVideoAdapter,hlsLoaders,hlsStallSignals,hlsBandwidth,chunkWarming},components/{LuminaryPlayer.vue,ScrubThumbnail.vue},ui/{controlsHtml,register,autoHide,scrubPreview,volume,keepAlive}}
```

## Detail

- `docs/claude/player.md`
