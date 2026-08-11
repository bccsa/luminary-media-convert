# Luminary Media Convert — Project Context

## Overview

A local-only desktop media encoder. A folder-based npm workspaces monorepo containing:

- **`api/`** — NestJS REST API service (the "Encoding API") that encodes media files into HLS/ABR format using FFmpeg (with optional NVIDIA or Apple Silicon GPU acceleration), uploads output to S3-compatible storage, and delivers status updates via SSE or polling. Also provides on-demand HLS preview streaming before/during encoding, a source storyboard and waveform for the trim timeline, a CMS handshake API, and a stateless HLS-edit API for mutating master playlists and reading/writing chapter and waveform sidecars in S3. Exposed as a library (`createServer()` in `api/src/bootstrap.ts`) so the desktop shell can host it in-process; `api/src/main.ts` is the same code path run standalone from the environment.
- **`app/`** — Vue 3 single-page client, the renderer of the desktop app: session list, local file pick, probe → encode config, trim/chapters authoring, preview and encoded playback. Served by the API itself in a packaged build, by Vite in development.
- **`electron/`** — Electron shell. Starts the Encoding API in the main process, serves the built `app/dist` through it, mints the UI's API token per launch, supplies a `safeStorage` credential cipher, shows the trust-on-first-use origin dialogs, registers the `luminary-convert://` protocol, and packages mac (dmg/zip) and Windows (NSIS) builds via electron-builder.
- **`cms-mock/`** — Dev-only Vue 3 app standing in for the Luminary CMS, so the whole CMS → encoder flow (origin gating, `documentId` reuse, `hlsUrl`/key delivery, `luminary://key` substitution, angle extraction) can be exercised locally. Not shipped; nothing depends on it.
- **`encode-config/`** — Shared Vue 3 component library providing the `EncodeConfigForm` component, encoding/probe type definitions, and layout-based config persistence. Published as `@luminary-media-converter/encode-config`.
- **`segment-editor/`** — Shared Vue 3 component library providing a player-agnostic timeline `SegmentEditor` for trim / chapters / subtitles authoring, plus WebVTT helpers (`exportChaptersVtt`, `exportSubtitlesVtt`, `parseVtt`). Published as `@luminary-media-converter/segment-editor`.
- **`hls/`** — Shared TypeScript library providing **lossless** HLS master/media playlist parsing and building (round-trips real FFmpeg output byte-faithfully, unknown tags/attributes preserved via WeakMap-backed metadata), the LMCENC encrypted-text-asset format helpers (`enc-format.ts`), S3-key utilities, sidecar path conventions, the `LUMINARY_KEY_PLACEHOLDER_URI` constant, and angle/audio-only extraction (text helpers + model-level `extractAngle`). Published as `@luminary-media-converter/hls`; consumed by `api/`, `app/`, `cms-mock/` and `player-core/`.
- **`player-core/`** — Framework-agnostic, headless player wrapper: HLS munging pipeline (client-side angle extraction, quality capping, key handling, LMCENC decryption), `PlayerController` state store, recovery/stall/coming-soon policy, and the `PlayerAdapter` contract for pluggable engines (hls.js today; AVPlayer/ExoPlayer adapters later in a Capacitor shell). Published as `@luminary-media-converter/player-core`. See `player-core/src/types.ts` for the full contract.
- **`player-web/`** — Web reference implementation of the player: `HlsJsAdapter` (hls.js on a plain `<video>`, in-memory AES key delivery via a custom key loader — no key blob URLs), `LuminaryPlayer.vue`, iOS-style fullscreen controls with orientation lock, and `PlayerMessages` i18n (every user-facing string overridable; scoped slots for full custom UI). It draws no chrome over the picture outside fullscreen: entering is a double-click / double-tap on the video, or `enterFullscreen()` from the host — which is where the button belongs (the encoder puts it beside its angle / audio / quality selectors). Inside fullscreen the controls, exit button included, are the player's. Published as `@luminary-media-converter/player-web`; consumed by `app/`.

There is **no** SaaS service, admin panel, Auth0, CouchDB, tus upload server, webhook delivery, or PWA/Cloudflare deployment. Those workspaces (`saas/`, `admin/`, `tusd/`) were removed in the local-only migration.

## Monorepo Structure

- Root `package.json` declares npm workspaces (`"workspaces": ["api", "app", "encode-config", "hls", "segment-editor", "player-core", "player-web", "cms-mock", "electron"]`)
- Dependencies are hoisted to the root `node_modules/`
- Run workspace scripts from root: `npm -w api run <script>` or `npm -w app run <script>`
- Root `npm run dev` — browser development: builds the shared libraries, then runs their watch builds (each Vue library watches JS and `.d.ts` side by side, so a type-check during dev is not left staring at a `dist` with no declarations), the API dev server and the Vite web client concurrently
- Root `npm run dev:electron` — desktop development: same watch builds plus a compiled API build, the Vite web client, and the Electron shell pointed at it

## Tech Stack

### API (`api/`)

- **Runtime**: Node.js with TypeScript (ES2023 target, `nodenext` modules)
- **Framework**: NestJS 11 (Express platform)
- **Embeddable**: `createServer(options)` in `bootstrap.ts` returns `{ app, port, url, close() }`. Host-specific values (API token, origin policy, credential cipher, window hook) arrive through the global `RuntimeOptionsModule`; `workDir` and the ffmpeg paths are set into `process.env` before Nest instantiates anything, because that is how the services already read them
- **Bind address**: loopback only (`127.0.0.1`), default port `31711` (`DEFAULT_PORT`); standalone `main.ts` defaults to `PORT=3000`
- **Authentication**: `AuthResolverGuard` resolving, in order, the instance API token (`X-API-Key`) → session token (`Authorization: Bearer sess_*`) → read token (`?token=read_*`, only on endpoints that opt in). Endpoints declare allowed methods with `@AuthTypes(...)`, defaulting to `['instance']`. The CMS endpoints are gated by browser Origin instead of by a key
- **Security headers**: `helmet` with a CSP that widens `img/connect/media/worker` sources only when the API is also serving the web client (playlists and segments come from whichever S3 endpoint the user configured, and are handed to the player as `blob:` URLs)
- **CORS**: origin decided per request by `OriginRegistry`; refusal withholds the header rather than raising. `privateNetworkAccessMiddleware` answers Chrome's Local Network Access preflight. `EXPOSED_HEADERS` lists everything the client reads off a response (currently `X-Storyboard-Complete`)
- **Rate limiting**: `@nestjs/throttler` (`short`: 100/sec, `medium`: 1000/min) with a global guard; the encode, CMS and HLS-edit controllers are `@SkipThrottle()`
- **Scheduling**: `@nestjs/schedule` — hourly sweep of abandoned sessions
- **Media processing**: FFmpeg via child_process (NVIDIA NVENC or Apple VideoToolbox when detected, CPU fallback), ffprobe for media analysis
- **S3 storage**: MinIO JS client (universal S3 compatibility: MinIO, R2, AWS S3, B2, Spaces)
- **Validation**: `class-validator` + `class-transformer` with a global `ValidationPipe` (transform, whitelist, forbidNonWhitelisted)
- **API docs**: `@nestjs/swagger` — published at `/api/docs` only when `enableSwagger` is passed (standalone `main.ts` does; the Electron host does not)
- **Testing**: Vitest (`*.spec.ts` colocated in `api/src/`, e2e in `api/test/`). Note: many specs were intentionally left broken during the migration — see `Todo.md`

### Desktop Shell (`electron/`)

- **Package**: `@luminary-media-converter/electron` (private), main `dist/main.js`, Electron 33, electron-builder 26
- **Main process** (`src/main.ts`): single-instance lock, `luminary-convert://` protocol client, settings persisted in `app.getPath('userData')/settings.json`, TOFU origin dialogs (serialized through a queue), `safeStorage`-backed credential cipher, bundled ffmpeg/ffprobe resolution, static web client resolution, graceful shutdown that waits for Nest's hooks before quitting
- **Renderer**: `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; external links are pushed to the system browser
- **Preload** (`src/preload.ts`): exactly three calls on `window.luminary` — `getApiToken()`, `getPathForFile(file)` (Electron 32 removed `File.path`; `webUtils` is only reachable in the preload), `showOpenDialog()`
- **Work directory**: `userData/work`

### Web Client (`app/`)

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6, Tailwind CSS v4, TypeScript
- **Routing**: Vue Router 4 (history mode) — `/` → `/sessions`, `/sessions`, `/sessions/:id`
- **Auth**: no sign-in. The UI's credential is the instance API token, taken from the preload bridge in the desktop app and from `VITE_API_TOKEN` in browser development (`src/auth-token.ts`)
- **API base**: same-origin by default (the packaged app is served by the API); `VITE_API_URL` for browser development
- **Media playback**: `LuminaryPlayer` from `@luminary-media-converter/player-web` (hls.js on a plain `<video>`, driven by the `player-core` controller). Angle switching, quality selection, audio tracks and encrypted playback all go through the controller; the AES key is fetched masked from `GET /api/sessions/:id/key`, unmasked in memory (`utils/keyMask.ts`) and handed to the player, which serves it to hls.js from memory — no key blob URLs
- **Shared packages**: `@luminary-media-converter/encode-config`, `@luminary-media-converter/segment-editor`, `@luminary-media-converter/hls`, `@luminary-media-converter/player-core`, `@luminary-media-converter/player-web`
- **Real-time updates**: SSE via `GET /api/sessions/:id/events`, with a polling fallback in `useSessionPoller`
- **Testing**: Vitest + `@vue/test-utils` + jsdom

### Shared Encode Config (`encode-config/`)

- Vue 3 library built with Vite 6 in library mode (watch build for dev)
- Exports `EncodeConfigForm`, probe/encode config types, `layoutStorage` (config persistence keyed by a media-layout fingerprint)
- Peer dependency: Vue 3

### Shared Segment Editor (`segment-editor/`)

- Vue 3 library, Vite 6 library mode with `vite-plugin-css-injected-by-js`, `vue-tsc` for type emit
- Exports `SegmentEditor`, `Segment` / `SegmentEditorMode` types, WebVTT helpers and time helpers
- Modes: `trim` (no labels, no overlap), `chapters` (labels, no overlap, ripple edit), `subtitles` (labels, overlap allowed)
- Player-agnostic: consumers pass `getCurrentTime()` and optional `onSeek` / `onPlayPause`
- Testing: Vitest with `@vue/test-utils` and jsdom

### Shared HLS Library (`hls/`)

- Pure TypeScript, built with `tsc`
- Exports master/media playlist parsers and builders, AES-128 key/IV utilities, `LUMINARY_KEY_PLACEHOLDER_URI`, `normalizeS3Key`, `deriveAngleName`, sidecar path conventions (`sidecarPath`), and the angle helpers `listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`
- Testing: Vitest
- Consumers: `api/`, `app/`, `cms-mock/`

### CMS Mock (`cms-mock/`)

- Vue 3 + Vite, runs on port **5199** deliberately: a different origin from the API, so every request goes through the real CORS / origin-gating path
- Panels: connection (`GET /api/cms/health`), create session (`POST /api/cms/sessions`), SSE console, playback check (fetches `hlsUrl`, lists angles, renders extracted single-angle and audio-only playlists, previews the `luminary://key` substitution)
- Form values persist to `localStorage`; defaults are prefilled for a local MinIO

## Project Structure

```
api/
├── src/
│   ├── main.ts                          # Standalone entry: dotenv + createServer({ enableSwagger: true })
│   ├── bootstrap.ts                     # createServer(): the embeddable API — helmet/CSP, static client, CORS, PNA, listen
│   ├── app.module.ts                    # Root module; AppModule.forRoot(runtimeOptions)
│   ├── runtime-options.module.ts        # @Global module binding host-supplied token / origin policy / cipher / window hook
│   ├── cors.config.ts                   # CORS options bound to the origin registry + LNA/PNA preflight middleware
│   ├── version.ts                       # API_VERSION, read from api/package.json (reported to the CMS)
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth-resolver.guard.ts       # instance token → session token → read token
│   │   ├── auth-types.decorator.ts      # @AuthTypes('master' | 'session' | 'read')
│   │   └── local-auth.config.ts         # LOCAL_API_TOKEN injection token + env fallback
│   ├── cms/
│   │   ├── cms.module.ts                # Provides OriginRegistry (shared by the controller and the CORS layer)
│   │   ├── origin-registry.ts           # Allowlist + trust-on-first-use approver, one approval in flight per origin
│   │   └── cms-session-hook.ts          # CMS_SESSION_HOOK — fire-and-forget "bring your window forward"
│   ├── encode/
│   │   ├── encode.module.ts
│   │   ├── encode.controller.ts         # /api/sessions — create, list, local-file, encode, status, SSE, delete, chapters, waveform, preview, storyboard
│   │   ├── cms.controller.ts            # /api/cms — health, sessions (origin-gated)
│   │   ├── session-status.ts            # SessionStatus union
│   │   ├── dto/
│   │   │   ├── create-session.dto.ts        # S3 + encryption + segment + byte-range + thumbnail options
│   │   │   ├── cms-create-session.dto.ts    # documentId, title, s3, publicBaseUrl, encryption.required, existingMedia (accepted, unused)
│   │   │   ├── cms-session-response.dto.ts  # sessionId, readToken, eventsUrl, apiVersion, reused (+ health DTO)
│   │   │   ├── local-file.dto.ts            # absolute path of a file already on this machine
│   │   │   ├── encode-config.dto.ts         # type, video renditions, audio groups, VBR, labels, trimSegments
│   │   │   ├── encryption-config.dto.ts     # enabled + optional keyUrl
│   │   │   ├── chapters.dto.ts              # session-scoped chapter write body
│   │   │   └── s3-config.dto.ts, probe-result.dto.ts, session-response.dto.ts, rendition.dto.ts, review-range.dto.ts
│   │   └── services/
│   │       ├── session.service.ts           # Session store + tokens + persistence (session.json, credentials.enc) + restore/sweep
│   │       ├── session-events.service.ts    # SSE event subject (SessionEvent shape)
│   │       ├── session-cleanup.service.ts   # Hourly sweep of abandoned sessions
│   │       ├── credential-cipher.ts         # CredentialCipher interface + CREDENTIAL_CIPHER token
│   │       ├── ingest.service.ts            # Shared post-ingest pipeline: probe → preview init → uploaded → prime waveform/storyboard
│   │       ├── probe.service.ts             # ffprobe wrapper + multi-strategy bitrate detection
│   │       ├── queue.service.ts             # FIFO encoding queue (one at a time, graceful drain)
│   │       ├── ffmpeg.service.ts            # FFmpeg process management, GPU detection, multi-angle master, stream-alignment probe
│   │       ├── ffbin.ts                     # ffmpegBin()/ffprobeBin() from FFMPEG_PATH/FFPROBE_PATH, else PATH; shellQuote()
│   │       ├── encode.service.ts            # Orchestrates the pipeline; generates the key, publishes hlsUrl at encode start
│   │       ├── encryption.service.ts        # AES-128 key/IV generation + #EXT-X-KEY injection
│   │       ├── encryption.worker.ts         # Worker thread for segment encryption
│   │       ├── byte-range.worker.ts         # Worker thread for byte-range consolidation
│   │       ├── segment-pipeline.service.ts  # Streaming encrypt → upload → byte-range pack with bounded concurrency
│   │       ├── s3.service.ts                # MinIO upload, canonicalPrefix()
│   │       ├── thumbnail.service.ts         # Output sprite sheets + WebVTT, and the pre-encode source storyboard
│   │       ├── waveform.service.ts          # Waveform peaks (cached per session, written as waveform.json sidecar)
│   │       ├── preview.service.ts           # On-demand HLS preview (ABR, MPEG-TS, trim-aware, GPU-accelerated)
│   │       ├── disk-space.ts                # Free-space guard with a reserve, checked before ingest and before encode
│   │       ├── output-estimate.ts           # Estimated output size / formatBytes
│   │       └── media-extensions.ts          # ALLOWED_EXTENSIONS allow-list (re-exported from bootstrap for the host's file picker)
│   └── hls-edit/
│       ├── hls-edit.module.ts
│       ├── hls-edit.controller.ts       # /api/hls — read, mutate, discover, chapters/read, chapters/write, waveform/read
│       ├── hls-edit.service.ts          # parse → mutate → If-Match write of master.m3u8 in S3
│       ├── s3-etag.service.ts           # ETag-aware GET/PUT with optimistic concurrency
│       ├── dto/                         # read, mutate, discover, chapters-read, chapters-write, waveform-read
│       └── operations/index.ts          # upsertSubtitle, removeSubtitle, upsertChapters, removeChapters

electron/
├── src/
│   ├── main.ts                          # App lifecycle, API host, settings, TOFU dialogs, cipher, IPC, protocol, shutdown
│   └── preload.ts                       # window.luminary: getApiToken, getPathForFile, showOpenDialog
├── bin/
│   └── README.md                        # How to source ffmpeg/ffprobe per platform (binaries are NOT committed)
├── electron-builder.yml                 # mac dmg+zip (arm64), win nsis (x64), extraResources, asar, protocol
├── package.json                         # dev / dist:mac / dist:win / pack
└── tsconfig.json

app/
├── src/
│   ├── main.ts                          # Vue app entry (router only — no auth provider)
│   ├── App.vue                          # Shell: primary nav + appearance menu
│   ├── router.ts                        # /sessions, /sessions/:id
│   ├── api.ts                           # Fetch client for the local API (X-API-Key or session Bearer)
│   ├── auth-token.ts                    # Preload bridge token, else VITE_API_TOKEN
│   ├── session-tokens.ts                # Session token map seeded from GET /api/sessions
│   ├── types.ts                         # App types + re-exports from encode-config
│   ├── components/
│   │   ├── AppPrimaryNav.vue, AccountMenu.vue   # nav shell; the "account" menu is now appearance/theme only
│   │   ├── FileDropZone.vue             # Drop / pick a local file (paths via the preload bridge)
│   │   ├── ProgressBar.vue, StatusBadge.vue, FormSelect.vue, FormSelectListbox.vue
│   │   ├── ConfirmDangerModal.vue, DeleteSessionModal.vue
│   │   └── session-view/
│   │       ├── SessionWorkflowPanel.vue      # Probe → encode config → start
│   │       ├── SessionTrimWorkspace.vue      # Trim timeline (waveform, storyboard, zoom, cuts)
│   │       ├── SessionPlayerStrip.vue        # LuminaryPlayer + angle/quality/audio selectors (usePlayerState)
│   │       ├── SessionPostProcessPanel.vue   # Chapters authoring
│   │       └── SessionOutputPanel.vue        # Output summary / playback URLs
│   ├── composables/
│   │   ├── useSessionPoller.ts          # SSE with polling fallback, stops on terminal status
│   │   ├── useChapters.ts               # Chapter load/save (localStorage draft + debounced write to the API)
│   │   ├── useChapterTrimSync.ts, useTrimDeletions.ts, useTrimPlayback.ts, useTrimmedStoryboard.ts
│   │   └── useStoryboard.ts, useEncodeEta.ts, useAppLayout.ts, useTheme.ts
│   ├── utils/                           # errors, format, status, storyboardVtt, trimPlayback, trimTimeline, keyMask
│   └── views/
│       ├── ActiveSessionsView.vue       # Session list (polls GET /api/sessions)
│       └── SessionView.vue              # Full session lifecycle
└── vite.config.ts                       # Port 5173, strictPort, Vitest config

cms-mock/
├── src/
│   ├── App.vue, main.ts, store.ts, types.ts
│   └── components/{ConnectionPanel,CreateSessionPanel,EventConsole,PlaybackCheck}.vue
├── README.md
└── vite.config.ts                       # Port 5199

hls/src/{index,parse,build,keys,sidecar,angles}.ts
encode-config/src/{index,types,EncodeConfigForm.vue,layoutStorage,styles.css}
segment-editor/src/{index,SegmentEditor.vue,types,time,vtt,styles.css}
```

## Architecture

### Where sessions come from

**Today, every session originates in the CMS.** The renderer lists sessions (`GET /api/sessions`, instance token), and the user drives one from the file pick onwards; it has no "new session" affordance, because it has nowhere to get an S3 destination or a `publicBaseUrl` from. `ActiveSessionsView` says as much: "Sessions opened from Luminary CMS".

`POST /api/sessions` (create a session with an inline S3 config, returning a session token) still exists and is fully supported — it is what the CMS route builds on and what an integration or a test harness uses directly. Nothing in `app/` calls it.

### The CMS contract

The CMS is an ordinary web app on another origin; the encoder listens on loopback. Nothing is ever uploaded from the browser, and the response never echoes back what was sent.

1. **`GET /api/cms/health`** — unauthenticated liveness probe returning `{ status: 'ok', apiVersion }`. The CMS calls this before showing the "upload media" affordance at all; when it fails it offers a `luminary-convert://` launch link instead.
2. **`POST /api/cms/sessions`** — authorised by the caller's `Origin`, not by a key (there is no credential a page could hold that the pages around it could not also read). Body:
   ```jsonc
   {
     "documentId": "post_01HTZ8Y0J4",      // idempotency key
     "title": "Episode 12",                 // shown in the local app
     "s3": { /* endPoint, port?, useSSL?, bucket, region?, accessKey, secretKey, pathPrefix? */ },
     "publicBaseUrl": "https://cdn.example.com/media",
     "encryption": { "required": true },    // optional; a CMS states a requirement, not a key policy
     "segmentDuration": 6,                  // optional
     "byteRange": true,                     // optional
     "byteRangeMaxFileSizeMB": 500,         // optional
     "thumbnails": true,                    // optional
     "existingMedia": { "hlsUrl": "…", "hlsKey": "…" }  // validated + accepted, NOT acted on yet
   }
   ```
   Response `201`:
   ```json
   {
     "sessionId": "…",
     "readToken": "read_…",
     "eventsUrl": "http://127.0.0.1:31711/api/sessions/<id>/events?token=read_…",
     "apiVersion": "0.0.1",
     "reused": false
   }
   ```
   - **Idempotency**: a repeat click on the same `documentId` returns the session already in flight (`reused: true`) rather than starting a second one. Only *active* sessions match — a finished one means "replace what is there".
   - **Per-session subfolder**: the destination becomes `<canonicalPrefix(pathPrefix)>/<sessionId>`, so a re-encode of the same post cannot half-overwrite the live output.
   - **Window focus**: creating (or reusing) a session fires `CMS_SESSION_HOOK`, which the Electron host uses to bring its window forward — the user has to pick a file, and the app may be behind the browser.
   - **`eventsUrl`** is built from the request's own `Host`, because the port is assigned by the host app and this process has no better idea of it than the caller does.
3. **SSE** — the CMS subscribes to `eventsUrl` with `EventSource`. Events are the `SessionEvent` shape:
   ```ts
   { sessionId, status, progress?, pipelineProgress?, queuePosition?, error?, files?,
     masterPlaylist?, thumbnailsVtt?, hlsUrl?, segmentFormat?,
     encoder?, probeResult?, ingestTotalBytes? }
   ```
   **The event that matters** is the first `status: "encoding"`: it carries `hlsUrl`, published at encode *start*, not at completion — the destination key is settled long before the first segment exists. The decryption key is **no longer part of any status/SSE payload**: the CMS fetches it from `GET /api/sessions/:id/key?token=read_…` → `{ maskedKeyHex }` and unmasks it (XOR with the first 16 bytes of `SHA-256(sessionId)` — self-inverse, formula published; an obscurity measure keeping raw keys out of logs/proxies, not DRM). `hlsUrl` + the unmasked key are what Luminary saves as `MediaDto { hlsUrl, hlsKey }`. `cms-mock/src/store.ts` (`captureHlsKey`) is the reference implementation.
4. **Polling fallback** — `GET /api/sessions/:id?token=read_…` returns the same `hlsUrl`, so a CMS that reconnects mid-encode can ask again; the key comes from the key endpoint as above.

### Trust model: three token tiers plus an origin allowlist

| Tier | Form | Who holds it | What it can do |
|---|---|---|---|
| Instance API token | `X-API-Key: <token>` | The app's own UI only | Everything. Minted per launch by the Electron main process (`randomBytes(32)`), handed to the renderer over the preload bridge, never written to disk. Standalone it falls back to `LOCAL_API_TOKEN` (or the deprecated `MASTER_API_KEY`) |
| Session token | `Authorization: Bearer sess_*` (also accepted as `?token=` on preview / waveform / storyboard routes) | The UI, per session | Drive one session: attach a file, start the encode, poll, delete, read/write its chapters, stream its preview |
| Read token | `?token=read_*` | The CMS that opened the session | Watch only: the SSE stream and the status endpoint. Cannot start, cancel, or reach the source file. Minted only for `origin: 'cms'` sessions |

`AuthResolverGuard` tries them in that order. A present-but-wrong `X-API-Key` is rejected immediately rather than falling through. The instance token is a superkey: it is accepted regardless of `@AuthTypes(...)`.

`/api/cms/*` sits outside that chain — it is gated by `Origin`. A request with no `Origin` (curl, or a renderer whose origin browsers report inconsistently) is accepted only from a loopback peer, so an origin-less request off the network cannot walk past the allowlist by omitting the header.

### Local Network Access, PNA and trust on first use

A public web app reaching `127.0.0.1` is a private-network request. Chrome sends `Access-Control-Request-Private-Network: true` on the preflight and drops the real request unless the response grants it — `privateNetworkAccessMiddleware` sets `Access-Control-Allow-Private-Network: true` on those preflights, and is registered *before* the CORS middleware, which is what ends the preflight response. That is only a grant of reachability; *who* may talk to the API is still the origin allowlist's decision, applied by the CORS layer on the same response.

`OriginRegistry` holds the allowlist:

- Origins are normalised (lower-cased, no trailing slash) and compared exactly.
- Known origin → synchronous yes. Unknown origin with no approver → no (a headless run cannot be talked into trusting anything it was not configured with).
- Unknown origin with an approver → the Electron host shows a native "Allow this site to use the encoder?" dialog. One approval is in flight per origin, and the host serialises dialogs through a queue, so two tabs — or a page that opens an event stream and posts a session in the same tick — cannot stack two modal sheets over one decision. A dialog that fails to open is not consent.
- Decisions persist to `userData/settings.json` as `allowedOrigins` / `deniedOrigins`. Denials are remembered too, so a site that keeps retrying cannot turn "no" into a dialog every few seconds.
- After binding, the server approves its own address (`http://<host>:<port>`, plus `127.0.0.1` and `localhost` forms), so the app never asks the user whether to trust itself.
- Standalone, the allowlist comes from `CMS_ALLOWED_ORIGINS` (comma-separated) and there is no approver.

### `luminary://key` and the client-side player contract

Encryption keys are generated locally (`randomBytes(16)`) and never leave the machine, so there is nothing to serve them over HTTP. When no explicit `keyUrl` is configured, `#EXT-X-KEY` is written with the sentinel URI `luminary://key` (`LUMINARY_KEY_PLACEHOLDER_URI`, exported from `@luminary-media-converter/hls`).

A Luminary player is therefore expected to:

1. Fetch the master and media playlists, decrypting LMCENC-wrapped ones (an encrypted session encrypts its playlists and sidecars too, unless it opted out).
2. Supply the key for `luminary://key` (and any other AES-128 key URI — a locally supplied key always wins). The wrapper normalizes key URIs to the sentinel and the engine adapter serves the raw bytes **from memory** (hls.js custom key loader; `AVAssetResourceLoaderDelegate` / ExoPlayer `DataSource` later) — a key blob URL is only the fallback for adapters without a key hook.
3. Feed the munged playlists to the engine. **`player-core` (`PlayerController` + pipeline) is the reference implementation**, with `player-web`'s `HlsJsAdapter`/`LuminaryPlayer` as the web engine binding; the media encoder app consumes exactly these.

The encoder writes **one** spec-correct multi-angle `master.m3u8`: each camera angle is an `#EXT-X-MEDIA:TYPE=VIDEO` rendition group and every `#EXT-X-STREAM-INF` carries `VIDEO="<group>"`. Most players ignore video rendition groups and simply play whichever variant their ABR logic picks, so narrowing happens client-side with the `hls/` helpers — this is the contract, not an implementation detail:

- `listVideoAngles(masterText)` → `{ id, name, isDefault }[]` (empty for a single-angle master)
- `extractAnglePlaylist(masterText, angleId)` → a master pinned to one angle; returns the input unchanged when there is nothing to narrow, so it is safe to apply unconditionally
- `extractAudioOnlyPlaylist(masterText)` → an audio-only master, one variant per audio `GROUP-ID`, or `null` when there are no audio groups

### Credential protection

S3 credentials arrive per session and must survive a restart without ever sitting in plaintext on disk.

- `session.json` (in `<workDir>/<sessionId>/`) **never** holds S3 keys, cipher or no cipher: `accessKey` / `secretKey` are written as `<redacted>` (`REDACTED_CREDENTIAL`).
- When the host supplies a `CredentialCipher`, the keys go in a `credentials.enc` sidecar beside it. The Electron implementation is a thin wrapper over `safeStorage`, whose key lives in the OS keychain and is unlocked by the logged-in user rather than by anything on disk.
- With no cipher (standalone dev, or a Linux desktop with no keyring), nothing is written and the API logs "S3 credentials are held in memory only" once. That is deliberate: a stranded session is a smaller problem than a plaintext key in the work directory.
- Both files are written `0o600` and swapped into place via a `.tmp` + rename.
- On restart, sessions are restored from `session.json`. Terminal sessions are purged outright, work directory and all. In-flight statuses become `failed` ("The encoder restarted while this session was in progress"). Any session whose credentials could not be recovered becomes `failed` with "Credentials unavailable after restart — create the session again from the CMS", and `hasUsableCredentials()` guards every path that would otherwise reach S3 with placeholders (encode start, chapter read/write).

### Encoding pipeline

1. `POST /api/cms/sessions` (the CMS) or `POST /api/sessions` (a direct integration) creates the session.
2. `POST /api/sessions/:id/local-file` attaches an absolute path. **The source is used where it is** — never copied, never moved, never written to or deleted, including on failure. Validated as absolute, a regular file, and in the `ALLOWED_EXTENSIONS` allow-list (which `bootstrap.ts` re-exports so the host's file picker offers exactly the extensions the API will accept).
3. `IngestService.finalizeUpload` runs the shared post-ingest pipeline: record the path → ffprobe → initialise the preview → status `uploaded` → prime the waveform cache and the source storyboard in the background.
4. The client computes a suggested encode config from the probe results (`EncodeConfigForm`); the user adjusts renditions / audio groups / copy / VBR and optionally marks trim segments.
5. `POST /api/sessions/:id/encode` validates the config (video needs ≥ 1 rendition and ≥ 1 audio group; every rendition's `audioGroupId` must exist; `copyStream` needs a `sourceTrackIndex`), refuses sessions without usable credentials, and enqueues. A `failed` session whose source file is still on disk may be retried (`canRetry` on the status response).
6. FIFO queue, one encode at a time.
7. `EncodeService` clears any previous output, generates the AES key/IV **before** flipping to `encoding`, publishes `hlsUrl` (`publicBaseUrl` + `/` + `<prefix>/master.m3u8`), and starts `SegmentPipelineService`, which polls the FFmpeg output directory and streams each new segment through encrypt → upload → byte-range pack with bounded concurrency, instead of waiting for the encode to finish.
8. FFmpeg probes per-stream start times: aligned streams (spread < 50 ms) get fMP4 (`.m4s` + `init.mp4`), misaligned streams fall back to MPEG-TS (`.ts`), because the player's TS transmuxer resynchronises audio/video PTS during playback. The choice is reported as `segmentFormat`.
9. After drain: `#EXT-X-KEY` tags injected (when encrypted), thumbnail sprites + `thumbnails.vtt` generated for video encodes, `waveform.json` written as a sidecar next to `master.m3u8`. On an encrypted session every `.m3u8` and `.vtt` is then LMCENC-encrypted with the same key (AES-128-CBC, fresh IV per file, `LMCENC01` magic — see `docs/encrypted-sidecar-format.md`) as the **final** pre-upload step; encrypted objects upload as `application/octet-stream`. `encryption.encryptPlaylists: false` opts out, for output that must stay readable by players that cannot decrypt playlists.
10. Completion sets `files`, `masterPlaylist`, `thumbnailsVtt` and `segmentFormat`, and emits the final event. The key is never in the payload — clients use `GET /api/sessions/:id/key`.

Disk is guarded on both ends: `disk-space.ts` refuses an ingest or an encode that will not fit, keeping a reserve (`DISK_RESERVE_BYTES`, default 2 GB), so a full volume cannot take the next encode down with it.

### Encoding features

- **Video + audio-only modes**: `EncodeConfigDto.type` is `'video'` or `'audio'`
- **Trim segments**: optional `trimSegments` restricts the encode to one or more `[in, out]` ranges, concatenated in order. The preview reflects the trimmed timeline so cut points can be checked before queueing
- **Byte-range HLS**: on by default; segments consolidated into fewer large files with `#EXT-X-BYTERANGE`, size-capped by `byteRangeMaxFileSizeMB` (default 500). Consolidation runs in `byte-range.worker.ts` so it does not block the event loop
- **Copy mode** (`-c:v copy` / `-c:a copy`) and **VBR** (CRF/CQ) per rendition and per audio group
- **Audio groups** mapped to renditions via HLS `#EXT-X-MEDIA` `GROUP-ID`; multi-track audio with language/name attributes; mono/stereo/5.1/7.1 via `-ac`
- **Multi-angle video**: multiple source video tracks become `TYPE=VIDEO` rendition groups in the single master (see the player contract above)
- **HLS encryption**: AES-128 via worker threads; key hex published at encode start
- **Thumbnails**: sprite sheets + WebVTT for the encoded output, plus a separate pre-encode *source storyboard* served from `/api/sessions/:id/thumbnails/*` so the trim timeline can show frames before anything is encoded (`X-Storyboard-Complete` tells the client when sampling has finished)
- **Waveform**: peaks computed once per source, cached on disk, served over HTTP for the trim UI and written to S3 as `waveform.json`

### Server-side on-demand HLS preview

`PreviewService` generates preview HLS on demand once the source is probed:

- 2–3 ABR renditions (480p/360p/240p), copy-mode for H.264/VP8/VP9 where possible
- Segments extracted on demand, cached under `<workDir>/<sessionId>/preview/`, with prefetch and a cap of 3 concurrent FFmpeg processes
- GPU-accelerated (NVENC / VideoToolbox) with CPU fallback, sharing `FfmpegService`'s detection
- Multi-audio: one track per language (or all when unlabelled), each `(rendition, audioTrack)` pair cached separately
- Trim-aware; MPEG-TS segments of 4 s
- Removed when the session is deleted

### Session persistence and sweeping

- Sessions live in memory and are mirrored to `<workDir>/<sessionId>/session.json` after anything worth keeping changes. Progress is deliberately not persisted — it ticks several times a second and is worthless after a restart
- `lastActivityAt` (not `createdAt`) decides abandonment, so a slow multi-gigabyte ingest is not mistaken for a closed tab; `touch()` records liveness during long transfers
- `SessionCleanupService` sweeps hourly (`SESSION_CLEANUP_CRON`) and removes only *idle* sessions — `created`, `uploading`, `uploaded` — idle longer than `SESSION_ABANDONED_MAX_AGE_HOURS` (default 6). Queued and encoding sessions are never swept
- Finished sessions are not swept on a clock; they are discarded at boot, so no age threshold has to stand in for "the user is done looking at this"
- Deleting a session removes its work directory whole (session record, preview cache, sidecars, credentials sidecar). `encrypting` and `uploading_to_s3` are the statuses that cannot be deleted — the pipeline is mid-write, and pulling its files out from under it leaves half an output in the bucket

## API Endpoints

Auth column: **instance** = the instance `X-API-Key` token; **session** = `Bearer sess_*`; **read** = `?token=read_*`; **origin** = browser Origin allowlist; **query token** = `?token=` carrying the session token.

### Encoding sessions (`/api/sessions`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sessions` | token | Create a session (S3 + encryption + segment/byte-range/thumbnail options). Returns `{ sessionId, sessionToken }` |
| GET | `/api/sessions` | token | List every session on this instance, newest first, including session tokens (the UI is the only holder of the instance token) |
| POST | `/api/sessions/:id/local-file` | token, session | Attach an absolute path to a file already on this machine. Returns once probed |
| POST | `/api/sessions/:id/encode` | token, session | Submit the encode config and enqueue. `202` |
| GET | `/api/sessions/:id` | token, session, read | Poll status: probe results, progress, `hlsUrl`, `canRetry`, `queuePosition`, trim segments, files on completion (no key — see `/key`) |
| GET | `/api/sessions/:id/events` | query token (session **or** read) | SSE event stream |
| GET | `/api/sessions/:id/key` | token, session, read | Masked AES-128 session key `{ maskedKeyHex }` (XOR `SHA-256(sessionId)[0..16]`, self-inverse). 404 when the session has no encryption |
| DELETE | `/api/sessions/:id` | token, session | Cancel and delete. Allowed from `created`, `uploading`, `uploaded`, `queued`, `encoding`, `failed`, `completed` — the terminal two included, which is the only way their disk is reclaimed. `encrypting` and `uploading_to_s3` are refused: the pipeline is mid-write |
| GET | `/api/sessions/:id/chapters?lang=en` | token, session | Read `chapters/<lang>.vtt` from the session's own prefix |
| PUT | `/api/sessions/:id/chapters?lang=en` | token, session | Write `chapters/<lang>.vtt` (≤ 1 MiB, `text/vtt`). `204` |
| GET | `/api/sessions/:id/waveform` | query token | Waveform peaks for the source (`{ peaks, numPeaks }`) |
| GET | `/api/sessions/:id/preview/audio-tracks` | query token | Preview audio tracks |
| GET | `/api/sessions/:id/preview/playlist.m3u8` | query token | Preview master playlist (`?audio=<index>`) |
| GET | `/api/sessions/:id/preview/r:rendition/playlist.m3u8` | query token | Preview rendition playlist |
| GET | `/api/sessions/:id/preview/r:rendition/:filename` | query token | Preview MPEG-TS segment |
| GET | `/api/sessions/:id/thumbnails/thumbnails.vtt` | query token | Source storyboard WebVTT (cues rewritten to absolute, token-carrying sprite URLs; `X-Storyboard-Complete`) |
| GET | `/api/sessions/:id/thumbnails/:filename` | query token | Source storyboard sprite sheet |

### CMS handshake (`/api/cms`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/cms/health` | none | `{ status: 'ok', apiVersion }` — is the local encoder installed and running |
| POST | `/api/cms/sessions` | origin | Open (or reuse) a session for a CMS document; returns `readToken` + `eventsUrl` |

### HLS edit (`/api/hls`, stateless, inline S3 credentials)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/hls/read` | token | Fetch and parse a master playlist; returns the parsed master + current ETag |
| POST | `/api/hls/mutate` | token | Apply ordered ops (upsert/remove subtitle, upsert/remove chapters) with `If-Match`; returns the new ETag. `409` on mismatch |
| POST | `/api/hls/discover` | token | Scan a folder prefix for HLS masters / angles |
| POST | `/api/hls/chapters/read` | token | Read `chapters/<lang>.vtt` under a prefix; `404` when absent |
| POST | `/api/hls/chapters/write` | token | Write `chapters/<lang>.vtt` under a prefix |
| POST | `/api/hls/waveform/read` | token | Read `waveform.json` under a prefix; `404` when absent |

## Session Lifecycle

```
created -> uploading -> uploaded -> queued -> encoding -> encrypting -> uploading_to_s3 -> completed
                                                       \-> failed
```

`failed` is reachable from any point. A `failed` session whose source file is still on disk and whose credentials are still usable reports `canRetry: true` and can be encoded again without re-ingesting.

## Key Conventions

- DTOs use `class-validator` and are validated by a global `ValidationPipe` (whitelist + forbidNonWhitelisted). Even fields nothing acts on yet — `existingMedia` — are validated, because a shape that was never checked is a shape that will be wrong by the time something reads it
- Session-level options (`segmentDuration`, `byteRange`, `byteRangeMaxFileSizeMB`, `thumbnails`, `encryption` — incl. `encryption.encryptPlaylists`) belong to session creation; `trimSegments` belongs to the encode config submitted at encode start
- Host-specific values reach the API through `AppModule.forRoot()` → `RuntimeOptionsModule` (a `@Global` module): `LOCAL_API_TOKEN`, `ORIGIN_POLICY`, `CREDENTIAL_CIPHER`, `CMS_SESSION_HOOK`. Never import `AppModule` directly — a bare import leaves those tokens unbound. `workDir` and the ffmpeg paths go through `process.env` instead, because that is how the services already read them and they are process-wide anyway
- ffmpeg/ffprobe are resolved per call through `ffbin.ts` (`FFMPEG_PATH` / `FFPROBE_PATH`, else PATH), never captured at import time, so the host can set them before Nest instantiates anything. `shellQuote()` exists because a macOS install path always contains a space
- The API binds loopback unconditionally (`DEFAULT_HOST`). CORS and tokens answer questions a remote caller only gets to ask if it can open the socket
- Anything the web client reads off a response header must be added to `EXPOSED_HEADERS` in `cors.config.ts`, or `response.headers.get()` silently returns null
- Responses a COEP-`credentialless` page embeds cross-origin (storyboard VTT and sprites) set `Cross-Origin-Resource-Policy: cross-origin`; Helmet's default of `same-origin` would have the browser drop them
- Object keys always go through `S3Service.canonicalPrefix()` — no leading, trailing or doubled slashes
- Graceful shutdown: `app.enableShutdownHooks()`; `QueueService` and `FfmpegService` implement `OnModuleDestroy`. The Electron host intercepts `before-quit`, awaits `server.close()`, and only then quits — quitting out from under Nest leaves orphan ffmpeg processes and half-written output
- All playback behavior lives in `player-core` (munging, quality capping, angle switching, recovery/stall policy, coming-soon polling, chapters/subtitles) so web and future native players behave identically; engine specifics live behind `PlayerAdapter` implementations (`player-web`'s `HlsJsAdapter`). Implementing apps talk to `PlayerController` only
- Quality capping is **load-time only**: `PlayerSource.maxHeight` munges higher renditions out of the playlist; a playing video keeps its old cap until the next `load()`. Selecting the `Audio only` pseudo-angle (`AUDIO_ONLY_ANGLE_ID`) plays a munged master with zero video variants — no video bytes are downloaded
- LMCENC (`docs/encrypted-sidecar-format.md`) is the only sanctioned way to encrypt playlists/VTTs; detection is by magic prefix, never by absence-sniffing, and plaintext assets keep working when a key is configured
- Encryption is one decision: an encrypted session encrypts segments, playlists, chapters and (once written) subtitles under the same key. Chapters saved after the encode are encrypted on write and decrypted on read by the same rule, so the output never ends up half-readable. Anything in the app that reads a delivered `.vtt` directly — the storyboard filmstrip — must decrypt it (`useStoryboardVttUrl`)
- The renderer's only privileged capabilities are the three preload calls. Everything else it does goes over HTTP to the local API like any other client, which keeps one set of rules about what is allowed

## Environment Variables

### API (`api/.env`, standalone only — the Electron host passes these in code)

| Variable | Default | Description |
|---|---|---|
| `LOCAL_API_TOKEN` | — | The instance API token accepted on `X-API-Key`. Unset disables key auth entirely. `MASTER_API_KEY` is still read, with a deprecation warning |
| `PORT` | `3000` (standalone `main.ts`) | HTTP port. The embedded default is `31711` (`DEFAULT_PORT`) |
| `HOST` | `127.0.0.1` | Bind address |
| `WORK_DIR` | `./work` | Scratch directory for sessions, previews, sidecars |
| `CMS_ALLOWED_ORIGINS` | — | Comma-separated origins trusted without asking (there is no approver standalone) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | PATH lookup | Absolute paths to the binaries |
| `FFMPEG_TIMEOUT_MS` | none | Max FFmpeg runtime before a forced kill |
| `FFMPEG_THREADS` | — | Thread count passed to FFmpeg |
| `DISK_RESERVE_BYTES` | `2147483648` | Free space to keep in hand on the work volume |
| `SESSION_ABANDONED_MAX_AGE_HOURS` | `6` | How long an idle session may sit before it is swept |
| `SESSION_CLEANUP_CRON` | `0 * * * *` | Sweep schedule |
| `S3_UPLOAD_STALL_TIMEOUT_MS` | `300000` | Stall detector for S3 uploads (measured in bytes sent, not files completed) |

### Web client (`app/.env`, browser development only)

| Variable | Description |
|---|---|
| `VITE_API_URL` | Base URL of the local API. Empty in the packaged app (same origin) |
| `VITE_API_TOKEN` | Stands in for the preload bridge token when running in a plain browser |

### Electron

| Variable | Description |
|---|---|
| `LUMINARY_PORT` | Override the API port |
| `ELECTRON_RENDERER_URL` | Dev renderer URL (default `http://localhost:5173`) |

## FFmpeg is a hard requirement

`ffmpeg-availability.ts` probes `ffmpeg -version` / `ffprobe -version` at startup and answers **presence**, which is a different question from the acceleration detection below and must not be confused with it: every capability probe fails identically whether a binary is absent or merely lacks NVENC, so asking only about capability reported a machine with no FFmpeg at all as "No GPU found, using CPU encoding" (Todo.md item 35).

- The **Electron host** refuses to open a window without it, offering *Get FFmpeg* / *Quit* — there is nothing useful to do in a window that cannot probe, preview, thumbnail or encode. It closes the server before exiting rather than quitting out from under Nest
- The **API** refuses ingest and encode start with `503` and the same user-facing text. Ingest is the one that matters: attaching a source probes it immediately, so a missing install used to present as a failed probe, which reads as a bad file
- `probeFfmpegBinaries` / `missingBinariesMessage` / `FFMPEG_DOWNLOAD_URL` are re-exported from `bootstrap.ts` so the host reaches the same verdict the API does. Call them *after* `createServer` (or after setting `FFMPEG_PATH` / `FFPROBE_PATH`) — the paths are read per call, so probing earlier asks about PATH instead of the bundled binaries
- **FFmpeg 4.4 or newer is required**, and that is what the user is told. The requirement is *enforced* by probing the binary for the options the pipeline uses unconditionally (`ffmpeg-capabilities.ts`), never by comparing version strings — real builds report `4.4.2-0ubuntu0.22.04.1`, `7.1.1_2` and `N-113140-gd12b0e6f4b`, and the nightly has no version to compare. `MIN_FFMPEG_VERSION` exists to tell people what to install; it was established by reading FFmpeg's own source at release tags (`-stats_period` is absent in `n4.3`, present in `n4.4`, and is the newest option required)
- **User-facing text says the version; the log says the options.** "The installed FFmpeg is too old (version 3.4.8). Luminary Media Convert needs FFmpeg 4.4 or newer" goes to the dialog; the list of unsupported flags goes to the log, where the reader is us

## GPU Detection

At startup `FfmpegService.onModuleInit()` detects the acceleration mode (`AccelMode`: `'cpu' | 'nvidia' | 'apple'`):

1. **NVIDIA**: `nvidia-smi` available + `ffmpeg -hwaccels` includes `cuda` → `h264_nvenc`, `scale_cuda`, `-hwaccel cuda -hwaccel_output_format cuda`
2. **Apple Silicon**: `darwin` + `arm64` + `videotoolbox` in `-hwaccels` + `h264_videotoolbox` in `-encoders` + `scale_vt` in `-filters` → `h264_videotoolbox`, `scale_vt`, `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
3. **CPU fallback**: `libx264` with resolution-based presets. Audio always encodes on CPU

`PreviewService` shares the same detection. The active mode is reported as `encoder` on status responses and SSE events.

This is exactly why the packaged app ships its own ffmpeg: hardware encoding is a compile-time decision, and a user's own build may have none of it.

## Development Workflows

### Browser development (fastest loop, no Electron)

```bash
npm install
npm run dev
```

Starts the shared-library watch builds, the API on `http://127.0.0.1:3000` (Swagger at `/api/docs`), and the web client on `http://localhost:5173`.

`api/.env`:

```bash
LOCAL_API_TOKEN=dev-token
# Every browser page that calls the API needs an entry — including the web
# client itself. In Electron it is same-origin and sends no Origin header, so
# it needs none there; in browser dev it is a cross-origin page like any other
# and is refused without this (there is no approver dialog outside Electron).
CMS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5199
```

`app/.env`:

```bash
VITE_API_URL=http://127.0.0.1:3000
VITE_API_TOKEN=dev-token
```

`VITE_API_URL` and the API's `PORT` have to agree; Electron's own default is `31711` (`DEFAULT_PORT` in `api/src/bootstrap.ts`), so setting `PORT` to that lets one `app/.env` serve both modes — at the cost of not being able to run `dev` and `dev:electron` at once.

Browser dev has no preload bridge, so a dropped file cannot be resolved to a real path — the local-file flow only works inside the Electron shell.

### Desktop development

```bash
npm run dev:electron
```

Builds the shared libraries and the API, then runs the Vite client and Electron together. The main process retries the renderer URL for 30 s, because Vite is routinely a few seconds behind Electron.

**Gotcha — `ELECTRON_RUN_AS_NODE`.** Some parent processes (VS Code's integrated terminal, agent runners) export `ELECTRON_RUN_AS_NODE=1`. With it set, `electron .` runs as a plain Node process: no window ever appears and none of the `app` / `BrowserWindow` code runs. If the desktop app "starts and does nothing", check `env | grep ELECTRON` and `unset ELECTRON_RUN_AS_NODE` first.

### Exercising the CMS flow

```bash
npm -w cms-mock run dev     # http://localhost:5199
```

Run it against a running API (default `http://127.0.0.1:31711`, editable in the UI). Its origin differs from the API's on purpose, so the real CORS / origin-gating path is exercised — in the desktop app the first request raises the native approval dialog. It walks health → create session → SSE console (highlighting the first event carrying `hlsUrl`, pinned in `MediaDto` shape) → playback check (angle extraction and the `luminary://key` substitution). Defaults assume a local MinIO with an anonymously readable `media` bucket.

## Packaging

`electron/electron-builder.yml`:

- **Targets**: macOS `dmg` + `zip` (arm64), Windows `nsis` (x64). Run `npm -w electron run dist:mac` / `dist:win`, or `pack` for an unpacked directory
- **All three build what they ship.** Each runs `build:workspaces` → the root's `build:bundled` (the five shared libraries, then the API, then the web client) before `electron-builder`. They used to compile only Electron's own TypeScript and package whatever `app/dist` and `api/dist` happened to contain — the last build anyone ran, or nothing at all on a clean clone, since both are gitignored. `npm -w` does not work from inside a workspace directory, hence the `cd ..` hop
- **A `VITE_*` value cannot follow a developer's `.env` into a build.** Vite bakes every one it finds into every bundle, so `app/src/api.ts` and `auth-token.ts` read theirs strictly inside `import.meta.env.DEV`, which no `vite build` sets. `API_BASE` compiles to `""` — same-origin, which is the only correct answer once the API is serving the client. Pinned by tests that assert `DEV: false` *with* the variables set, not merely absent (Todo.md item 33)
- **`asar: true`** — verified rather than assumed: the packaged app was launched from outside the repository (so nothing could resolve upwards into the development `node_modules`) and the API started, served the client and answered requests from inside the archive
- **electron-builder 26 is required.** Version 25 collected the hoisted workspace dependencies incompletely — `call-bind-apply-helpers` ended up only nested under `call-bind`, express failed to load, and Nest reported it as "No driver (HTTP) has been selected", which points nowhere near the real cause. Symptom if this regresses: the packaged app exits or logs a missing-driver error while the same code runs fine unpackaged
- **`npmRebuild: false`** — electron-builder would otherwise run its own production `npm install` inside the workspace, which in a hoisted monorepo prunes the root `node_modules` out from under the running build. Nothing here is a native module
- **`extraResources`**: `app/dist` → `app/` (served at `/` by the API via `bundledWebClient()`), and `electron/bin/${platform}-${arch}/{ffmpeg,ffprobe}` → the resources root (found by `bundledBinary()`)
- **ffmpeg binaries are not in the repository** — tens of megabytes each and separately licensed. See `electron/bin/README.md` for where to get builds with VideoToolbox (macOS arm64) and NVENC (Windows x64), how to verify them, and the GPL/LGPL consequences of shipping them. Without them the packaged app falls back to whatever `ffmpeg` is on PATH: runnable on a developer machine, not shippable
- **Unsigned.** `mac.identity: null`, `hardenedRuntime: false` — there is no Developer ID certificate in this project, so Gatekeeper requires right-click → Open on first launch. Windows builds are likewise unsigned, and have never been built or tested
- **Protocol**: `luminary-convert://` is registered so a CMS can offer a launch link when the encoder is not running. From source, the scheme is registered against `process.execPath` plus the resolved project path, or the OS would launch a bare Electron with no app to run
- Excluded from the package: `.env`, the API workspace's `work/` directory, and its lint/build config

## Follow-ups

Known gaps and deferred work are tracked in [`Todo.md`](Todo.md). Notably: CMS edit mode for existing collections (`existingMedia` is accepted and ignored), auto-update and code signing, Linux builds, Windows build verification, stale-collection cleanup, and restoring the test suites that were intentionally broken during the migration.
