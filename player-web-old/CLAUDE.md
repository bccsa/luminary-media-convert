# player-web-old/ — retired, frozen

## Overview

- **`player-web-old/`** — **Retired and frozen**: the hls.js test implementation that `player-web` replaced and has moved ahead of — `HlsJsAdapter` (in-memory AES key via a custom hls.js key loader), its own iOS-style fullscreen controls and scrub thumbnails. Nothing consumes it, and nothing builds or tests it: it is outside `build:libs`, `ci:libs`, the dev watchers and CI on purpose, so it may stop compiling as `player-core` moves on. Still a workspace, so its dependencies (`hls.js` among them) stay installed; kept for reference. Package name `@luminary-media-converter/player-web-old`.
