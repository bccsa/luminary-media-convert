# player-core/ — headless player wrapper

## Overview

- **`player-core/`** — Framework-agnostic, headless player wrapper: HLS munging pipeline (client-side angle extraction, quality capping, key handling, LMCENC decryption), `PlayerController` state store, coming-soon polling, and the `PlayerAdapter` contract for pluggable engines (Video.js/hls.js today; AVPlayer/ExoPlayer adapters later in a Capacitor shell). Headless in the strict sense — no `Blob`, no `URL.createObjectURL`, no DOM — so a host must supply a `ServeStrategy` (`PlayerControllerOptions.serveStrategy` is required; the web's blob-backed one lives in `player-web`). Detection and recovery are the engine's: an adapter spends its own ladder before raising a fatal `error`, and reaches back through exactly one door — `reload-requested` — for the only repair no engine can make, rebuilding a munged source. Published as `@luminary-media-converter/player-core`. See `player-core/src/types.ts` for the full contract and `docs/suspension-safe-playback.md` for why the line falls there.

## Detail

- `docs/claude/player.md` — the player contract and the conventions below it
- `docs/suspension-safe-playback.md`, `docs/chunk-warming.md`, `docs/encrypted-sidecar-format.md`
- `player-core/src/types.ts` — the full contract
