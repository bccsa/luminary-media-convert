# app-electron/ — Electron shell

## Overview

- **`app-electron/`** — Electron shell. Starts the Encoding API in the main process, serves the built `app/dist` through it, mints the UI's API token per launch, supplies a `safeStorage` credential cipher, shows the trust-on-first-use origin dialogs, registers the `luminary-convert://` protocol, and packages mac (dmg/zip) and Windows (NSIS) builds via electron-builder.

### Desktop Shell (`app-electron/`)

- **Package**: `@luminary-media-converter/electron` (private), main `dist/main.js`, Electron 33, electron-builder 26
- **Main process** (`src/main.ts`): single-instance lock, `luminary-convert://` protocol client, settings persisted in `app.getPath('userData')/settings.json`, TOFU origin dialogs (serialized through a queue), `safeStorage`-backed credential cipher, bundled ffmpeg/ffprobe resolution, static web client resolution, graceful shutdown that waits for Nest's hooks before quitting, and a new-release check (`src/update-check.ts`): 5 s after a packaged launch, and from **Check for Updates…**, it compares `app.getVersion()` with GitHub's latest release and offers this machine's installer (Download / Release Notes / Later / Skip This Version, the skip remembered as `skippedVersion`). Notification only — an unsigned app cannot update itself (#206). **Bump `app-electron/package.json`'s version for every release**: that is the number compared against the tag
- **Renderer**: `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; external links are pushed to the system browser
- **Preload** (`src/preload.ts`): exactly five calls on `window.luminary` — `getApiToken()`, `getPathForFile(file)` (Electron 32 removed `File.path`; `webUtils` is only reachable in the preload), `showOpenDialog()`, and the CMS-session pair `onShowSession(cb)` / `takePendingSession()`
- **Work directory**: `userData/work`

### Environment


| Variable                | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `LUMINARY_PORT`         | Override the API port                              |
| `ELECTRON_RENDERER_URL` | Dev renderer URL (default `http://localhost:5173`) |

## Conventions

- The renderer's only privileged capabilities are the three preload calls. Everything else it does goes over HTTP to the local API like any other client, which keeps one set of rules about what is allowed

## Project Structure (`app-electron/`)

```
app-electron/
├── src/
│   ├── main.ts                          # App lifecycle, API host, settings, TOFU dialogs, cipher, IPC, protocol, shutdown
│   └── preload.ts                       # window.luminary: getApiToken, getPathForFile, showOpenDialog
├── bin/
│   └── README.md                        # How to source ffmpeg/ffprobe per platform (binaries are NOT committed)
├── electron-builder.yml                 # mac dmg+zip (arm64), win nsis (x64), extraResources, asar, protocol
├── package.json                         # dev / dist:mac / dist:win / pack
└── tsconfig.json
```

## Detail

- `docs/claude/packaging.md` — electron-builder, ffmpeg binaries, signing, protocol
- `docs/claude/development.md` — desktop dev and the `ELECTRON_RUN_AS_NODE` gotcha
- `docs/claude/api-architecture.md` — the API this shell hosts
