# player-web/ — simple Video.js 10 web player

## Overview

- **`player-web/`** — The browser engine for `player-core` plus a simple player. Engine: `HlsJsVideoAdapter` over `player-core`'s `PlayerAdapter` contract on `<hlsjs-video>` (`@videojs/hlsjs-video`), the hls.js request seam (`adapter/hlsLoaders.ts`: `luminary://key` from memory, live playlists as `luminary://live/<n>`, a long time-to-first-byte for byte-range segments), stall detection from hls.js errors (`hlsStallSignals.ts`) feeding `drivers/RecoveryLadder`, `BlobServeStrategy`, and the chunk-warming loop. Player: `components/LuminaryPlayer.vue` on Video.js 10's **stock** `<video-skin>`; options (`controls.ts`) are `audioMenu`, `subtitlesMenu` and `windowedControls`, applied by a stylesheet appended to the skin's open shadow root. `windowedControls: false` makes the skin `inert` while windowed (bare frame, double-click → fullscreen). Its own coming-soon and error panels replace the skin's error dialog. Consumers: the encoder `app/` and the Luminary CMS's video preview. The Luminary app's full player UI lives in the Luminary repo (`app/src/media-player/player/`) and imports this package's engine, so keep the engine exports in `src/index.ts` stable. Dev harness: `npm -w player-web run demo` (port 5182); Playwright e2e (`npm -w player-web run test:e2e`) covers playback and the built bundle.

## Files

```
player-web/src/{index,elements,controls,messages,youtube,singleFlight,styles.css}
player-web/src/{adapter/{HlsJsVideoAdapter,hlsLoaders,hlsStallSignals,hlsBandwidth,hlsTypes,chunkWarming},drivers/{RecoveryLadder,clock},serve/{BlobServeStrategy,livePlaylistUri},composables/usePlayerState,components/LuminaryPlayer.vue}
```

## Detail

- `docs/claude/player.md`
