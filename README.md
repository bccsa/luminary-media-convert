# Luminary Media Convert

A local-only desktop media encoder. It takes a file already on your machine, encodes it to HLS/ABR with FFmpeg (GPU-accelerated where the hardware allows), optionally encrypts it with AES-128, and uploads the result straight to your own S3-compatible storage. Nothing is uploaded to us, because there is no us: the encoder, the UI and the credentials all live on the one machine.

It also speaks to the Luminary CMS. A user clicking "upload media" on a post in their browser opens a session on the local encoder; the file is chosen in the desktop app, and the CMS is handed back a playback URL and (when encrypted) the key, over a live event stream.

## Architecture

```
   Luminary CMS (browser, another origin)          Desktop app (Electron)
              │                                    ┌──────────────────────────┐
              │  GET  /api/cms/health              │  main process            │
              │  POST /api/cms/sessions ──────────►│   • Encoding API (Nest)  │
              │       (gated by Origin, TOFU)      │   • safeStorage cipher   │
              │                                    │   • origin dialogs       │
              │  SSE  /api/sessions/:id/events ◄───│   • ffmpeg / ffprobe     │
              │       hlsUrl, progress, status     │                          │
              │  GET  /api/sessions/:id/key ──────►│                          │
              │       the AES-128 key, masked      │                          │
                                                   │  renderer = app/dist     │
                                                   └───────────┬──────────────┘
                                                               │  local file, by reference
                                                               ▼
                                                    S3-compatible storage
                                                    (the user's own bucket)
```

The API binds to `127.0.0.1` only. The renderer authenticates with a token minted per launch and passed over the preload bridge; a CMS is authorised by its browser Origin, approved once by the user in a native dialog and remembered thereafter.

## Workspaces

| Workspace            | Description                                            | README                                                                     |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `api/`               | Encoding API — NestJS, embeddable via `createServer()` | [api/README.md](api/README.md)                                             |
| `app/`               | Vue 3 renderer UI                                      | [app/README.md](app/README.md)                                             |
| `app-electron/`      | Desktop shell, hosts the API in-process, packaging     | [app-electron/bin/README.md](app-electron/bin/README.md) (ffmpeg binaries) |
| `cms-mock/`          | Dev-only stand-in for the Luminary CMS                 | [cms-mock/README.md](cms-mock/README.md)                                   |
| `encode-config/`     | Shared encode-config form + types                      | [encode-config/README.md](encode-config/README.md)                         |
| `hls-core/`          | Shared HLS parsing, key utilities, angle extraction    | —                                                                          |
| `player-core/`       | Player pipeline: fetch, decrypt, extract angles, state | —                                                                          |
| `player-web/`        | Web player over the `PlayerAdapter` contract           | —                                                                          |
| `player-web-legacy/` | The same contract on Video.js 8 / VHS                  | [player-web-legacy/README.md](player-web-legacy/README.md)                 |
| `ffmpeg-build/`      | Builds the bundled LGPL FFmpeg                         | [ffmpeg-build/README.md](ffmpeg-build/README.md)                           |

## Prerequisites

- **Node.js** ≥ 18
- **FFmpeg + ffprobe** on `PATH` for development, with `aac` and a hardware H.264 encoder for your machine — `h264_videotoolbox` + `scale_vt` on Apple Silicon, `h264_nvenc` on NVIDIA. Deliberately **not** a `libx264` build: there is no software H.264 fallback left anywhere, because packaged builds ship an LGPL FFmpeg without it and development is meant to fail the same way. Packaged builds ship their own — see [app-electron/bin/README.md](app-electron/bin/README.md)
- An **S3-compatible bucket** to write output to (MinIO, R2, AWS S3, B2, Spaces…)

## Quick start

```bash
npm install
```

### Browser development (fastest loop)

```bash
npm run dev
```

Runs the shared-library watch builds, the API on `http://127.0.0.1:3000` (Swagger at `/api/docs`), and the web client on `http://localhost:5173`.

`api/.env`:

```bash
MASTER_API_KEY=dev-token
CMS_ALLOWED_ORIGINS=http://localhost:5199
```

`app/.env`:

```bash
VITE_API_URL=http://127.0.0.1:3000
VITE_API_TOKEN=dev-token
```

There is no preload bridge in a plain browser, so a dropped file cannot be resolved to a real path — the local-file flow needs the Electron shell.

### Desktop development

```bash
npm run dev:electron
```

Builds the libraries and the API, then runs Vite and Electron together.

> If the app starts and no window ever appears, check for `ELECTRON_RUN_AS_NODE=1` in your environment (VS Code terminals and some agent runners set it) and `unset` it. With it set, `electron .` runs as plain Node.

### Testing the CMS flow

```bash
npm -w cms-mock run dev     # http://localhost:5199
```

A dev-only app that drives the real handshake against the running encoder: health check, `POST /api/cms/sessions`, an SSE console that highlights the first event carrying `hlsUrl` + `encryptionKeyHex`, and a playback check that lists video angles, renders the extracted single-angle and audio-only playlists, and previews the `luminary://key` substitution a player performs. It runs on a different origin on purpose, so origin gating and CORS are genuinely exercised. Defaults assume a local MinIO with an anonymously readable `media` bucket.

## Packaging

Each command builds the encoder it ships first, then the workspaces, then the app —
so a clean clone produces a complete artifact with no separate steps.

```bash
npm -w app-electron run dist:mac            # dmg + zip, arm64 and x64
npm -w app-electron run dist:win            # NSIS installer, x64 — needs a Windows machine
npm -w app-electron run dist:win-portable   # portable zip, x64 — builds on macOS too
npm -w app-electron run pack                # unpacked directory, for inspection
npm -w app-electron run verify-package      # assert every packaged app can actually encode
```

Artifacts land in `app-electron/release/`, named `<product>-<version>-<mac|win>-<arch>.<ext>`.
Neither the artifacts nor the ffmpeg binaries are in the repository.

### What each build needs

| Target                 | Host           | Prerequisites                                                        |
| ---------------------- | -------------- | -------------------------------------------------------------------- |
| macOS dmg/zip          | macOS          | `brew install nasm pkg-config gnupg` (plus the Xcode CLT)            |
| Windows portable zip   | macOS or Linux | the above, plus `brew install mingw-w64 cmake llvm`                  |
| Windows NSIS installer | Windows        | a Windows machine, or Wine — which is why the portable target exists |

**LLVM is not optional for the Windows build.** `--enable-cuda-llvm` gives `scale_cuda`
for the NVIDIA path and needs a clang with the NVPTX backend, which Apple's clang does
not have. Put it first on `PATH`:

```bash
PATH="/opt/homebrew/opt/llvm/bin:$PATH" npm -w app-electron run dist:win-portable
```

The ffmpeg build itself is [`ffmpeg-build/README.md`](ffmpeg-build/README.md) — why we
build rather than download, what goes in, and the LGPL position. `app-electron/bin/README.md`
covers where the binaries land and their licences.

### What is signed, and what a user sees

Builds are **unsigned** — there is no Developer ID and no Authenticode certificate, so
there is no auto-update either. macOS bundles are still _ad-hoc_ signed by
`app-electron/build/after-pack.cjs`, without which a downloaded copy is refused outright as
"damaged". On macOS 15 and later, opening an unsigned app takes System Settings →
Privacy & Security → **Open Anyway**; right-click → Open no longer works, Apple removed
it. Windows shows a SmartScreen warning. The portable Windows build additionally carries
the stock Electron icon, because stamping it needs Wine.

Signing, notarization and auto-update are tracked in [#206](https://github.com/bccsa/luminary-media-convert/issues/206).

## Scripts

| Command                                                                             | What it does                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                                                                       | Libraries (watch) + API + web client                  |
| `npm run dev:electron`                                                              | Libraries (watch) + API build + web client + Electron |
| `npm -w api run dev`                                                                | API dev server with watch                             |
| `npm -w api run build` / `test` / `test:e2e`                                        | Build and test the API                                |
| `npm -w app run dev` / `build` / `test`                                             | Web client                                            |
| `npm -w cms-mock run dev`                                                           | CMS mock on port 5199                                 |
| `npm -w app-electron run dev` / `dist:mac` / `dist:win` / `pack`                    | Desktop shell                                         |
| `npm -w app-electron run dist:win-portable`                                         | Portable Windows zip, buildable on macOS              |
| `npm -w {hls-core,encode-config,player-core,player-web} run build` / `dev` / `test` | Shared libraries                                      |

## Documentation

- [CLAUDE.md](CLAUDE.md) — the deep reference: architecture, CMS contract, trust model, endpoint tables, conventions, packaging notes
- [api/README.md](api/README.md) — API reference, authentication, environment, encoding workflow, output layout
- [app/README.md](app/README.md) — renderer structure and environment
- [Issues](https://github.com/bccsa/luminary-media-convert/issues) — known gaps and follow-up work
- [PATENTS.md](PATENTS.md) — the patent position, which no copyright licence covers

## Consuming the player libraries

An app that embeds `player-web` or `player-web-legacy` needs the five library
workspaces built — they ship only `dist/` — and needs none of the desktop app to
do it. `npm run ci:libs` installs exactly that subset, and `npm run build:libs`
builds it:

```bash
npm run ci:libs      # ~180 MB, no electron
npm run build:libs
```

A plain `npm ci` installs every workspace, which pulls in `electron` and
`electron-builder` and downloads the Electron binary — around 500 MB and a
lengthy download, to produce five small libraries. That is the right thing when
working on the encoder and the wrong thing in a consumer's image build.

The workspace list in `ci:libs` is the one in `build:libs`. Adding a library
means adding it to both, which is why they sit next to each other.

## Licensing

Licensed per directory rather than repository-wide, because the pieces are not
all destined for the same audience: the shared libraries are meant to be consumed
by other applications, while the build scripts are a separate concern.

|                                                                                                                                                    | Licence          |                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| every workspace — `api/`, `app/`, `app-electron/`, `encode-config/`, `hls-core/`, `player-core/`, `player-web/`, `player-web-legacy/`, `cms-mock/` | Apache-2.0       | each carries its own `LICENSE`                                                                                         |
| `ffmpeg-build/`                                                                                                                                    | GPL-3.0-or-later | carries its own `LICENSE`; the build scripts also carry an SPDX header                                                 |
| everything else — `docs/`, `test-media/`, the root files                                                                                           | Apache-2.0       | the root `LICENSE`                                                                                                     |
| the bundled FFmpeg and FFprobe                                                                                                                     | LGPL-2.1         | built without `--enable-gpl` and without libx264; `COPYING.LGPLv2.1` and `LICENSE-ffmpeg.txt` ship beside the binaries |

The LGPL build is enforced rather than assumed: `verify-package.mjs` fails the
package unless the shipped encoder reports LGPL and carries no libx264, and it
reads `BUILDCONF.txt` for targets the packaging machine cannot execute.

Substitution is what the LGPL asks in return for shipping this way. The encoder
resolves in order: `FFMPEG_PATH`, then a directory the user chooses in the app,
then the bundled binary.
