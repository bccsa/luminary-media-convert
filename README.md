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
              │       hlsUrl + encryptionKeyHex    │                          │
                                                   │  renderer = app/dist     │
                                                   └───────────┬──────────────┘
                                                               │  local file, by reference
                                                               ▼
                                                    S3-compatible storage
                                                    (the user's own bucket)
```

The API binds to `127.0.0.1` only. The renderer authenticates with a token minted per launch and passed over the preload bridge; a CMS is authorised by its browser Origin, approved once by the user in a native dialog and remembered thereafter.

## Workspaces

| Workspace | Description | README |
|---|---|---|
| `api/` | Encoding API — NestJS, embeddable via `createServer()` | [api/README.md](api/README.md) |
| `app/` | Vue 3 renderer UI | [app/README.md](app/README.md) |
| `electron/` | Desktop shell, hosts the API in-process, packaging | [electron/bin/README.md](electron/bin/README.md) (ffmpeg binaries) |
| `cms-mock/` | Dev-only stand-in for the Luminary CMS | [cms-mock/README.md](cms-mock/README.md) |
| `encode-config/` | Shared encode-config form + types | [encode-config/README.md](encode-config/README.md) |
| `segment-editor/` | Shared timeline editor (trim / chapters / subtitles) | [segment-editor/README.md](segment-editor/README.md) |
| `hls/` | Shared HLS parsing, key utilities, angle extraction | — |

## Prerequisites

- **Node.js** ≥ 18
- **FFmpeg + ffprobe** on `PATH` for development (with `libx264` and `aac`; `h264_nvenc` for NVIDIA, `h264_videotoolbox` + `scale_vt` for Apple Silicon). Packaged builds ship their own — see [electron/bin/README.md](electron/bin/README.md)
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

```bash
npm -w electron run dist:mac    # dmg + zip, arm64
npm -w electron run dist:win    # NSIS installer, x64
npm -w electron run pack        # unpacked directory, for inspection
```

Put `ffmpeg` / `ffprobe` in `electron/bin/<platform>-<arch>/` first — they are not in the repository. See [electron/bin/README.md](electron/bin/README.md) for sourcing, verification and licensing.

Builds are currently **unsigned**: macOS Gatekeeper needs a right-click → Open on first launch, and there is no auto-update. The Windows configuration exists but has never been built or tested. See [Todo.md](Todo.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Libraries (watch) + API + web client |
| `npm run dev:electron` | Libraries (watch) + API build + web client + Electron |
| `npm -w api run dev` | API dev server with watch |
| `npm -w api run build` / `test` / `test:e2e` | Build and test the API |
| `npm -w app run dev` / `build` / `test` | Web client |
| `npm -w cms-mock run dev` | CMS mock on port 5199 |
| `npm -w electron run dev` / `dist:mac` / `dist:win` / `pack` | Desktop shell |
| `npm -w {hls,encode-config,segment-editor} run build` / `dev` / `test` | Shared libraries |

## Documentation

- [CLAUDE.md](CLAUDE.md) — the deep reference: architecture, CMS contract, trust model, endpoint tables, conventions, packaging notes
- [api/README.md](api/README.md) — API reference, authentication, environment, encoding workflow, output layout
- [app/README.md](app/README.md) — renderer structure and environment
- [Todo.md](Todo.md) — known gaps and follow-up work
