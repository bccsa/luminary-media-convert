# hls-core/ — lossless HLS parsing and building

## Overview

- **`hls-core/`** — Shared TypeScript library providing **lossless** HLS master/media playlist parsing and building (round-trips real FFmpeg output byte-faithfully, unknown tags/attributes preserved via WeakMap-backed metadata), the LMCENC encrypted-text-asset format helpers (`enc-format.ts`), S3-key utilities, sidecar path conventions, the `LUMINARY_KEY_PLACEHOLDER_URI` constant, and angle/audio-only extraction (text helpers + model-level `extractAngle`). Published as `@luminary-media-converter/hls-core`; consumed by `api/`, `app/`, `cms-mock/` and `player-core/`.

### Shared HLS Library (`hls-core/`)

- Pure TypeScript, built with `tsc`
- Exports master/media playlist parsers and builders, AES-128 key/IV utilities, `LUMINARY_KEY_PLACEHOLDER_URI`, `normalizeS3Key`, `deriveAngleName`, sidecar path conventions (`sidecarPath`), and the angle helpers `listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`
- Testing: Vitest
- Consumers: `api/`, `app/`, `cms-mock/`

## Files

```
hls-core/src/{index,parse,build,keys,sidecar,angles}.ts
```

## Detail

- `docs/claude/player.md` — conventions that govern what the player does with these playlists
