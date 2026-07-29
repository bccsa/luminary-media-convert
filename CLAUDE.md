# Luminary Media Convert — Project Context

## Overview

A folder-based npm workspaces monorepo containing:

- **`api/`** — NestJS REST API service (the "Encoding API") that encodes media files into HLS/ABR format using FFmpeg (with optional NVIDIA or Apple Silicon GPU acceleration), uploads output to S3-compatible storage, and delivers status updates via SSE, webhooks, or polling. Also provides on-demand HLS preview streaming during upload, HTTP/S URL ingestion as an alternative to tus uploads, and a stateless HLS-edit API for mutating master playlists and writing chapter sidecars in S3.
- **`app/`** — Vue 3 single-page web client for uploading files (tus or "From URL" mode), monitoring encoding sessions, editing chapters, and managing API keys and S3 configs.
- **`saas/`** — NestJS SaaS Service providing multi-tenant user management, session history, webhook ingestion, API key management, S3 config storage, an admin dashboard, and a thin proxy layer over the Encoding API's HLS-edit and chapter endpoints. Backed by CouchDB and authenticated via Auth0 JWT.
- **`admin/`** — Vue 3 admin panel SPA for managing users, sessions, and viewing the dashboard. Authenticated via Auth0.
- **`encode-config/`** — Shared Vue 3 component library providing the `EncodeConfigForm` component, encoding/probe type definitions, and layout-based config persistence. Published as `@luminary-media-converter/encode-config` for consumption by the app (and potentially other clients).
- **`segment-editor/`** — Shared Vue 3 component library providing a player-agnostic timeline `SegmentEditor` for trim / chapters / subtitles authoring, plus WebVTT helpers (`exportChaptersVtt`, `exportSubtitlesVtt`, `parseVtt`). Published as `@luminary-media-converter/segment-editor`.
- **`hls/`** — Shared TypeScript library providing HLS master/media playlist parsing and building, key/IV utilities, and sidecar path conventions (chapters, subtitles, thumbnails). Published as `@luminary-media-converter/hls`; consumed by both `api/` and `saas/`.
- **`tusd/`** — Node.js wrapper (`node-tusd`) around the Go `tusd` binary, providing a `TusdServer` class that spawns tusd as a child process, proxies HTTP requests, and dispatches lifecycle hooks (auth, upload create/finish, progress) via an internal HTTP hook server.

## Monorepo Structure

- Root `package.json` declares npm workspaces (`"workspaces": ["api", "app", "encode-config", "hls", "segment-editor", "tusd", "saas", "admin"]`)
- Dependencies are hoisted to the root `node_modules/`
- Run workspace scripts from root: `npm -w api run <script>` or `npm -w app run <script>`
- Root `npm run dev` starts all workspaces concurrently (via `concurrently`): encode-config watch build, segment-editor watch build, hls watch build, API dev server, SaaS dev server, web client dev server, and admin panel dev server

## Tech Stack

### API (`api/`)

- **Runtime**: Node.js with TypeScript (ES2023 target, `nodenext` modules)
- **Framework**: NestJS 11 (Express platform)
- **Authentication**: Composite `AuthResolverGuard` resolving (in order) Master API Key (env `MASTER_API_KEY`, via `X-API-Key` header) → tenant API Key (validated via webhook to the SaaS Service) → Session Token (Bearer `sess_*` for session-scoped endpoints). Endpoints declare allowed methods via the `@AuthTypes(...)` decorator. Auth0 JWT is no longer used by the Encoding API directly; clients reach it via API keys (or the SaaS proxy)
- **Rate limiting**: `@nestjs/throttler` (`short`: 100/sec, `medium`: 1000/min). High-throughput endpoints (SSE, segment streaming, tus, encode lifecycle) use `@SkipThrottle()`
- **Media processing**: FFmpeg via child_process (NVIDIA NVENC or Apple VideoToolbox when GPU detected, CPU fallback), ffprobe for media analysis
- **S3 storage**: MinIO JS client (universal S3 compatibility: MinIO, R2, AWS S3, B2, etc.)
- **Validation**: `class-validator` + `class-transformer` with a global `ValidationPipe`
- **API docs**: `@nestjs/swagger` (OpenAPI at `/api/docs`)
- **CORS**: Enabled via `CORS_ORIGIN` env var (defaults to `http://localhost:5173`)
- **Testing**: Vitest (`*.spec.ts` colocated in `api/src/`, e2e in `api/test/` via `test:e2e` config)
- **Code style**: Prettier (single quotes, 4-space indent), ESLint with TypeScript ESLint

### Shared Encode Config (`encode-config/`)

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6 (library mode, watch build for dev)
- **Language**: TypeScript
- **Exports**: `EncodeConfigForm` Vue component, probe/encode config TypeScript types, `layoutStorage` utilities
- **Peer dependency**: Vue 3

### Shared Segment Editor (`segment-editor/`)

- **Package name**: `@luminary-media-converter/segment-editor`
- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6 (library mode with `vite-plugin-css-injected-by-js`; `vue-tsc` for type emit)
- **Exports**: `SegmentEditor` Vue component, `Segment` / `SegmentEditorMode` types, WebVTT helpers (`exportChaptersVtt`, `exportSubtitlesVtt`, `parseVtt`, `formatVttTimestamp`, `parseVttTimestamp`), and time helpers (`formatTime`, `formatDuration`, `parseTime`)
- **Modes**: `trim` (no labels, no overlap), `chapters` (labels, no overlap, ripple-edit by default), `subtitles` (labels, overlap allowed)
- **Player-agnostic**: consumers pass `getCurrentTime()` and optional `onSeek` / `onPlayPause` callbacks; works with any HTML video/audio element or Video.js
- **Testing**: Vitest with `@vue/test-utils` and `jsdom`
- **Peer dependency**: Vue 3

### Shared HLS Library (`hls/`)

- **Package name**: `@luminary-media-converter/hls`
- **Runtime**: Pure TypeScript library (no framework dependency), built via `tsc`
- **Exports**: master/media playlist parsers and builders (`parseMasterPlaylist`, `buildMasterPlaylist`, etc.), AES-128 key/IV utilities, and sidecar path conventions (`sidecarPath` for chapters, subtitles, thumbnails)
- **Testing**: Vitest
- **Consumers**: `api/` (encoding output, HLS-edit module) and `saas/` (session import, HLS proxy)

### Tusd Wrapper (`tusd/`)

- **Package name**: `node-tusd` (private workspace package)
- **Runtime**: Node.js with TypeScript (ES2023 target, `nodenext` modules, ESM)
- **Core**: Wraps the Go `tusd` binary via child process spawning + HTTP proxying
- **Hook server**: Internal Express-like HTTP server receives webhook callbacks from tusd
- **Binary resolution**: 3-level fallback — `TUSD_BINARY_PATH` env var → local `bin/tusd` → system PATH
- **Testing**: Jest
- **Exports**: `TusdServer` class, `findTusdBinary` utility, TypeScript types (`TusdServerConfig`, `RequestInfo`, `UploadInfo`, `HookType`)

### Web Client (`app/`)

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6
- **Routing**: Vue Router 4 (history mode)
- **Styling**: Tailwind CSS v4
- **Language**: TypeScript
- **Authentication**: Auth0 via `@auth0/auth0-vue` SDK (Universal Login, automatic token management)
- **Media playback**: Video.js 8 with custom HLS quality selector and thumbnail preview plugins; client-side encrypted HLS playback via blob URL rewriting in `HlsPlayer.vue`; chapter cues injected from the chapter sidecar VTT (player-reported duration is treated as authoritative over source probe duration)
- **Testing**: Vitest
- **API communication**: Fetch-based client (`api.ts`) communicates with both the SaaS Service and the Encoding API; file uploads use `tus-js-client` for resumable chunked uploads (50 MB chunks, 5 parallel uploads), or "From URL" mode where the API server downloads the source from a public HTTP/S URL
- **Real-time updates**: SSE via `GET /api/sessions/:id/events` on the Encoding API for live encoding progress
- **Shared packages**: `@luminary-media-converter/encode-config` (form, types, layout storage) and `@luminary-media-converter/segment-editor` (chapter editor, WebVTT helpers)
- **PWA**: `vite-plugin-pwa` — installable manifest, Workbox precache of app shell only, update prompt via `PwaUpdatePrompt.vue`; `app/public/_headers` for COOP/COEP and SW cache control on Cloudflare deploy

### SaaS Service (`saas/`)

- **Runtime**: Node.js with TypeScript (ES2023 target, `nodenext` modules)
- **Framework**: NestJS 11 (Express platform)
- **Authentication**: Auth0 JWT validation via `@nestjs/passport` + `passport-jwt` + `jwks-rsa` (admin guard on admin-only endpoints; `@SkipAdmin()` to bypass)
- **Rate limiting**: `@nestjs/throttler` (`short`: 20/sec, `medium`: 100/min)
- **Database**: CouchDB via `nano` client
- **Scheduling**: `@nestjs/schedule` for periodic tasks (session cleanup)
- **Testing**: Vitest
- **Modules**: Auth, Users, Sessions, Webhooks, Dashboard, S3Configs, Me, Keys, Crypto, Database
- **Outbound proxy**: `hls-edit.client.ts` forwards HLS-edit and chapter requests from authenticated users to the Encoding API using the master key, so browsers never see API credentials

### Admin Panel (`admin/`)

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6
- **Routing**: Vue Router 4 (history mode)
- **Styling**: Tailwind CSS v4
- **Language**: TypeScript
- **Authentication**: Auth0 via `@auth0/auth0-vue` SDK
- **Testing**: Vitest

## Project Structure

```
api/
├── src/
│   ├── main.ts                          # Entry point: bootstraps NestJS, Swagger, CORS, raw body parser
│   ├── app.module.ts                    # Root module: imports AuthModule, EncodeModule, HlsEditModule, ThrottlerModule (global guard)
│   ├── auth/
│   │   ├── auth.module.ts              # Auth module — exports AuthResolverGuard + KeyValidationWebhookService
│   │   ├── auth-resolver.guard.ts      # Composite guard: master key (env) → API key (validated via webhook) → session Bearer token
│   │   ├── auth-types.decorator.ts     # @AuthTypes('master', 'apikey', 'session') metadata for endpoints
│   │   ├── authorization-webhook.service.ts # Outbound authorization webhook for create-session policy
│   │   ├── key-validation-webhook.service.ts # Outbound webhook to SaaS to validate user API keys (LRU cached)
│   │   └── key-validation.types.ts
│   ├── encode/
│   │   ├── encode.module.ts             # Feature module
│   │   ├── encode.controller.ts         # REST endpoints under /api/sessions (create, encode, SSE, preview, url-upload, delete)
│   │   ├── dto/
│   │   │   ├── create-session.dto.ts    # Session creation request (S3 + webhook + encryption + segment + thumbnail config)
│   │   │   ├── encode-config.dto.ts     # Encoding configuration (type, video renditions, audio groups, VBR, labels, trimSegments)
│   │   │   ├── encryption-config.dto.ts # HLS encryption configuration DTO
│   │   │   ├── probe-result.dto.ts      # Probe result DTOs for Swagger docs
│   │   │   ├── rendition.dto.ts         # Legacy rendition DTO (unused — VideoRenditionDto in encode-config.dto.ts is used)
│   │   │   ├── review-range.dto.ts      # Review range DTOs (keyframe-aligned in/out points, not yet wired up)
│   │   │   ├── s3-config.dto.ts         # S3 storage credentials
│   │   │   ├── url-upload.dto.ts        # HTTP/S URL ingestion request (url + optional filename override)
│   │   │   ├── webhook-config.dto.ts    # Webhook URL + session token
│   │   │   ├── session-response.dto.ts  # Response DTOs (create, upload, encode, status + anglePlaylists + encoder + segmentFormat + thumbnailsVtt)
│   │   │   └── webhook-payload.dto.ts   # Webhook callback payload + SessionStatus type (includes encryptionKeyHex)
│   │   └── services/
│   │       ├── session.service.ts       # In-memory session store + token management
│   │       ├── probe.service.ts         # ffprobe wrapper: media analysis + multi-strategy bitrate detection
│   │       ├── queue.service.ts         # FIFO encoding queue (one-at-a-time, graceful drain on shutdown)
│   │       ├── ffmpeg.service.ts        # FFmpeg process management, GPU detection, angle playlist generation, stream alignment detection
│   │       ├── s3.service.ts            # S3 upload via MinIO client (with concurrency options)
│   │       ├── webhook.service.ts       # Webhook POST delivery
│   │       ├── session-events.service.ts # SSE event emitter for real-time session updates (RxJS Subject)
│   │       ├── encode.service.ts        # Orchestrates encoding pipeline (async hooks support)
│   │       ├── encryption.service.ts    # AES-128 HLS encryption (key derivation + worker-based segment encryption)
│   │       ├── encryption.worker.ts     # Worker thread for encryption processing
│   │       ├── byte-range.worker.ts     # Worker thread for non-blocking byte-range HLS segment consolidation
│   │       ├── segment-pipeline.service.ts # Streaming pipeline: poll FFmpeg output dir → encrypt → upload → byte-range pack with bounded concurrency
│   │       ├── media-extensions.ts      # Allow-list of media file extensions + Content-Type → extension mapping
│   │       ├── thumbnail.service.ts     # Sprite-based thumbnail generation with WebVTT
│   │       ├── tus-upload.service.ts    # Resumable file upload via tusd Go binary (node-tusd wrapper)
│   │       ├── url-fetch.service.ts     # HTTP/S source ingestion: parallel Range downloads, SSRF guards, progress + heartbeat events
│   │       └── preview.service.ts       # On-demand HLS preview: ABR renditions, segment extraction, GPU-accelerated transcoding, trim-segment aware
│   └── hls-edit/
│       ├── hls-edit.module.ts           # Feature module
│       ├── hls-edit.controller.ts       # Stateless endpoints under /api/hls (read, mutate, discover, chapters/read, chapters/write)
│       ├── hls-edit.service.ts          # Orchestrates parse → mutate → If-Match write of master.m3u8 in S3
│       ├── s3-etag.service.ts           # ETag-aware S3 GET/PUT with optimistic concurrency
│       ├── dto/
│       │   ├── read.dto.ts              # Read request (inline S3 credentials)
│       │   ├── mutate.dto.ts            # Mutate request (ordered ops + If-Match ETag)
│       │   ├── discover.dto.ts          # Discover request (folderPrefix scan for masters / angles)
│       │   ├── chapters-read.dto.ts     # Read chapter sidecar VTT
│       │   └── chapters-write.dto.ts    # Write chapter sidecar VTT
│       └── operations/                  # Mutation operation handlers (upsertSubtitle, removeSubtitle, upsertChapters, removeChapters)
│           └── index.ts

encode-config/
├── src/
│   ├── index.ts                         # Package entry: exports EncodeConfigForm, types, layoutStorage
│   ├── types.ts                         # Shared types: ProbeResult, EncodeConfig, VideoRendition, AudioGroup, etc.
│   ├── EncodeConfigForm.vue             # Probe results display + encoding config (renditions, audio groups, VBR, copy)
│   ├── layoutStorage.ts                 # Encode config persistence keyed by media layout fingerprint
│   ├── styles.css                       # Component styles
│   └── env.d.ts                         # Vue SFC type declarations
├── package.json
├── vite.config.ts
└── tsconfig.json

segment-editor/
├── src/
│   ├── index.ts                         # Package entry: SegmentEditor + types + VTT/time helpers
│   ├── SegmentEditor.vue                # Player-agnostic timeline editor (trim / chapters / subtitles)
│   ├── types.ts                         # Segment, SegmentEditorMode, createSegmentId
│   ├── time.ts                          # formatTime / formatDuration / parseTime
│   ├── vtt.ts                           # exportChaptersVtt / exportSubtitlesVtt / parseVtt / format/parseVttTimestamp
│   ├── styles.css                       # Component styles + CSS custom properties for theming
│   └── env.d.ts
├── __tests__/                           # Vitest tests
├── README.md                            # Detailed usage / props / shortcuts reference
├── package.json
├── vite.config.ts
├── vitest.config.ts
└── tsconfig.json

hls/
├── src/
│   ├── index.ts                         # Re-exports parse, build, keys, sidecar
│   ├── parse.ts                         # parseMasterPlaylist / parseMediaPlaylist
│   ├── build.ts                         # buildMasterPlaylist / buildMediaPlaylist
│   ├── keys.ts                          # AES-128 key/IV utilities
│   ├── sidecar.ts                       # sidecarPath() — chapters/subtitles path conventions
│   └── *.spec.ts                        # Vitest tests
├── package.json
└── tsconfig.json

app/
├── src/
│   ├── main.ts                          # Vue app entry point (Auth0, Vue Router)
│   ├── App.vue                          # Root component (Auth0 identity check, navigation shell)
│   ├── router.ts                        # Vue Router routes (sessions, keys, s3-configs, import)
│   ├── api.ts                           # Fetch-based API client (SaaS Service + Encoding API + preview + url-upload + chapters)
│   ├── api.spec.ts                      # API client tests (Vitest)
│   ├── types.ts                         # App-specific types (S3Config, SessionStatus, etc.) + re-exports from encode-config
│   ├── style.css                        # Global styles (Tailwind import)
│   ├── videojs-quality-selector.ts      # Custom Video.js HLS quality selector plugin (native ES6)
│   ├── videojs-thumbnail-preview.ts     # Custom Video.js thumbnail preview plugin (timeline scrubbing)
│   ├── components/
│   │   ├── SessionConfigForm.vue        # S3 config + file selection form (tus or "From URL" mode)
│   │   ├── FileDropZone.vue             # Drag-and-drop file upload area
│   │   ├── HlsPlayer.vue               # Reusable Video.js HLS player: client-side encrypted playback (blob URL rewriting), chapter cue track injection
│   │   ├── ProgressBar.vue              # Reusable progress bar component
│   │   ├── StatusBadge.vue              # Reusable status badge with icon support
│   │   └── InlineConfirm.vue            # Inline confirmation with overlay positioning
│   ├── composables/
│   │   ├── useActiveUploads.ts          # Singleton upload tracker surviving navigation (tus + URL ingest)
│   │   ├── useChapters.ts               # Chapter sidecar load/save: localStorage draft + debounced autosave to SaaS, parse/export VTT
│   │   └── useSessionPoller.ts          # Polling composable (2s interval, auto-stops on terminal status)
│   ├── views/
│   │   ├── EncodeView.vue               # New encoding session (S3 config + file/URL selection → create + start upload/url-fetch → navigate to session)
│   │   ├── SessionView.vue              # Unified session lifecycle view (uploading → encoding config → progress → playback) with preview player, audio track selector, and chapter editor (during/after encoding)
│   │   ├── SessionHistoryView.vue       # Paginated session list with search and filters
│   │   ├── SessionImportView.vue        # Import external HLS outputs
│   │   ├── ApiKeysView.vue              # API key management
│   │   └── S3ConfigsView.vue            # S3 config management
│   └── utils/                           # (empty — layoutStorage moved to encode-config package)
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── vite.config.ts
└── env.d.ts

tusd/
├── src/
│   ├── index.ts                         # Package entry: exports TusdServer, findTusdBinary, types
│   ├── server.ts                        # TusdServer class: spawns tusd binary, manages lifecycle
│   ├── types.ts                         # Config and hook types (TusdServerConfig, RequestInfo, UploadInfo, HookType)
│   ├── hook-server.ts                   # Internal HTTP server receiving webhook callbacks from tusd binary
│   ├── proxy.ts                         # HTTP proxy forwarding requests to tusd child process
│   └── binary.ts                        # Tusd binary resolution: TUSD_BINARY_PATH env → bin/tusd → system PATH
├── bin/
│   └── tusd                             # Compiled tusd Go binary (platform-specific)
├── scripts/
│   └── download-tusd.sh                 # Downloads tusd binary for the current platform
├── __tests__/                           # Jest tests (tusd workspace)
├── package.json
└── tsconfig.json

saas/
├── src/
│   ├── main.ts                          # Entry point: bootstraps NestJS, Swagger, CORS
│   ├── app.module.ts                    # Root module: imports all feature modules
│   ├── auth/
│   │   ├── auth.module.ts              # Auth module (Passport + JWT strategy)
│   │   ├── jwt.strategy.ts            # Auth0 JWT validation strategy
│   │   ├── jwt-auth.guard.ts          # NestJS guard wrapping Passport JWT
│   │   ├── admin.guard.ts             # Admin role guard
│   │   ├── skip-admin.decorator.ts    # Decorator to bypass admin guard
│   │   └── identity.service.ts        # User identity resolution + provisioning
│   ├── crypto/
│   │   ├── crypto.module.ts            # Crypto module
│   │   └── crypto.service.ts           # Encryption utilities (API key hashing, etc.)
│   ├── database/
│   │   ├── database.module.ts          # CouchDB database module
│   │   ├── database.service.ts         # CouchDB client via nano
│   │   └── indexes.ts                  # CouchDB design document indexes
│   ├── users/
│   │   ├── users.module.ts             # Users module
│   │   ├── users.controller.ts         # User CRUD endpoints (admin)
│   │   ├── users.service.ts            # User persistence in CouchDB
│   │   ├── dto/                        # Create/update/response DTOs
│   │   └── interfaces/                 # User document interface
│   ├── sessions/
│   │   ├── sessions.module.ts          # Sessions module
│   │   ├── sessions.controller.ts      # User-facing session endpoints (CRUD, url-upload, name, move, rename-prefix, check-prefix, hls/read, hls/mutate, chapters GET/PUT)
│   │   ├── admin-sessions.controller.ts # Session management endpoints (admin)
│   │   ├── sessions.service.ts         # Session persistence in CouchDB
│   │   ├── session-events.service.ts   # Session event handling
│   │   ├── session-cleanup.service.ts  # Periodic cleanup of stale sessions
│   │   ├── hls-parser.service.ts       # HLS manifest parsing for session import (uses @luminary-media-converter/hls)
│   │   ├── hls-edit.client.ts          # Outbound HTTP client that proxies HLS-edit / chapter calls to the Encoding API using the master key
│   │   ├── s3-client.service.ts        # S3 client for session import operations
│   │   ├── dto/                        # Create / import / url-upload / move-session-files / rename-session-prefix / response / S3 / encryption DTOs
│   │   └── interfaces/                 # Session document interface
│   ├── webhooks/
│   │   ├── webhooks.module.ts          # Webhooks module
│   │   ├── webhooks.controller.ts      # Webhook ingestion endpoints (from Encoding API)
│   │   ├── webhooks.service.ts         # Webhook processing + session status updates
│   │   └── dto/                        # Authorize request, encoding webhook, validate key DTOs
│   ├── keys/
│   │   ├── keys.module.ts              # API keys module
│   │   ├── keys.controller.ts          # API key CRUD endpoints (user-facing)
│   │   ├── admin-keys.controller.ts    # API key management endpoints (admin)
│   │   ├── keys.service.ts             # API key persistence + hashing in CouchDB
│   │   ├── dto/                        # Create/response DTOs
│   │   └── interfaces/                 # API key document interface
│   ├── s3-configs/
│   │   ├── s3-configs.module.ts        # S3 configs module
│   │   ├── s3-configs.controller.ts    # S3 config CRUD endpoints (user-facing)
│   │   ├── s3-configs.service.ts       # S3 config persistence in CouchDB (encrypted credentials)
│   │   ├── dto/                        # Create/update/response DTOs
│   │   └── interfaces/                 # S3 config document interface
│   ├── dashboard/
│   │   ├── dashboard.module.ts         # Dashboard module
│   │   ├── dashboard.controller.ts     # Dashboard stats endpoints (admin)
│   │   └── dashboard.service.ts        # Aggregated stats from CouchDB
│   └── me/
│       ├── me.module.ts                # Me module
│       └── me.controller.ts            # Current user profile endpoint
├── package.json
└── tsconfig.json

admin/
├── src/
│   ├── main.ts                          # Vue app entry point (Auth0, Vue Router)
│   ├── App.vue                          # Root component (navigation shell)
│   ├── router.ts                        # Vue Router routes (dashboard, users, sessions)
│   ├── api.ts                           # Fetch-based API client (SaaS Service admin endpoints)
│   ├── utils/
│   │   └── status.ts                    # Session status utilities
│   └── views/
│       ├── DashboardView.vue            # Admin dashboard with stats
│       ├── UsersListView.vue            # User list with search
│       ├── UserDetailView.vue           # User detail view
│       ├── UserFormView.vue             # User create/edit form
│       ├── SessionsListView.vue         # Session list with filters
│       └── SessionDetailView.vue        # Session detail view
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Architecture

### Two-phase encoding pipeline

1. **POST** `/api/sessions` — Client sends S3 config + optional webhook/encryption/thumbnail config (authenticated by master key or tenant API key)
2. Service returns `{ sessionId, tusEndpoint, sessionToken, maxUploadSize }`
3. Source ingestion — one of:
   - **Tus**: Client uploads the source file via the **tus protocol** to `/api/tus` using the session token (resumable, chunked); or
   - **From URL**: Client calls `POST /api/sessions/:id/url-upload` with a public HTTP/S URL — the API server downloads the source directly with parallel HTTP Range requests and SSRF guards
4. On upload/ingestion completion, API auto-probes the file with ffprobe and sets session status to `uploaded`
5. Client polls `GET /api/sessions/:id` (or subscribes to SSE) to receive probe results — detected tracks (video and audio metadata)
6. Client computes suggested encoding config from probe results, user reviews and modifies (renditions, audio groups, copy/VBR toggles, optional trim segments); auto-selects audio-only mode when no video tracks detected
7. **POST** `/api/sessions/:id/encode` — Client submits final encoding config (type: `'video'` or `'audio'`, with optional `trimSegments`)
8. Session enters FIFO queue; webhook sent (if configured) with `queued` status + queue position
9. When session reaches front of queue, FFmpeg probes stream start times and encodes to HLS with ABR variants (fMP4 segments when streams are aligned, MPEG-TS fallback when misaligned). When `trimSegments` is set, only those time ranges are encoded and concatenated in order
10. Progress updates sent via SSE (`GET /api/sessions/:id/events`), webhooks (~every 5%), or client polls `GET /api/sessions/:id`
11. For video encodes, master playlist is post-processed (audio names, video groups) and per-angle playlists generated when multiple video tracks are present
12. Output files uploaded to client-specified S3 bucket via MinIO client (with configurable concurrency); `SegmentPipelineService` streams segments through encrypt → upload → byte-range pack as FFmpeg produces them, instead of waiting for the full encode to finish
13. Final webhook sent with `completed` status + list of S3 object keys + master playlist + angle playlists (if applicable) + `encryptionKeyHex` (when encryption is enabled)

### Media analysis (ProbeService)

- Wraps `ffprobe -v quiet -print_format json -show_format -show_streams`
- Detects video tracks (codec, resolution, bitrate, frame rate, profile, language, name)
- Detects audio tracks (codec, bitrate, channels, sample rate, language, name)
- Multi-strategy bitrate detection per stream: `bit_rate` → `tags.BPS` → `tags.NUMBER_OF_BYTES`/`tags.DURATION` → packet-based CSV computation via ffprobe
- Returns raw probe results to the client; encoding config suggestions are computed entirely in the `EncodeConfigForm` component (from the `encode-config` package)

### URL ingestion (UrlFetchService)

Alternative to tus uploads — the API server downloads the source media directly from a public HTTP/S URL:

- **HEAD probe + smart fallback**: Probes content length, Content-Disposition, Content-Type, and Range support; derives a filename and validates the extension against the media allow-list (`media-extensions.ts`)
- **Parallel Range downloads**: Splits the file into `streams` ranges (default 4, max 16) when the source supports `Accept-Ranges: bytes` and the file is ≥ 16 MB; falls back to single-stream when not supported
- **SSRF guards**: Resolves the hostname via DNS and blocks cloud-metadata endpoints (`169.254.0.0/16`, link-local IPv6 `fe80::/10`); only `http`/`https` protocols accepted
- **Progress + heartbeat events**: Reports byte progress every 500 ms and emits heartbeat events every 2 s so the SSE stream and webhooks stay live
- **Cancellation**: Tracks per-session `AbortController` so deleting the session cleanly aborts the in-flight download
- **Status flow**: `created` → `uploading` (with download progress) → `uploaded` (auto-probed by ffprobe), exactly like the tus path so downstream logic is unchanged

### Server-side on-demand HLS preview

`PreviewService` generates HLS preview streams on-demand during the encoding phase (or after upload completes):

- **ABR preview renditions**: Intelligently generates 2-3 transcode renditions (480p/360p/240p) or uses copy-mode for H.264/VP8/VP9 codecs. Segments extracted on-demand during playback and cached locally
- **GPU-accelerated transcoding**: Supports NVIDIA NVENC (`h264_nvenc` + `scale_cuda`) and Apple VideoToolbox (`h264_videotoolbox` + `scale_vt`) with automatic CPU fallback
- **Concurrency control**: Limits to 3 concurrent FFmpeg processes for segment extraction; prefetches upcoming segments for smooth playback
- **Multi-audio support**: Intelligently selects audio tracks (one per language, or all if no language metadata). Filters to max 150 kbps per track. Client-side audio track selector dropdown. Each (rendition, audioTrack) pair cached separately
- **Trim-segment aware**: When the encode config specifies `trimSegments`, the preview reflects the trimmed timeline so the user can verify cut points before queueing the full encode
- **Segment format**: HLS segments in MPEG-TS format, 4 seconds each. Master playlist aggregates all renditions with BANDWIDTH and RESOLUTION info
- **Cache**: Preview cache in `${WORK_DIR}/${sessionId}/preview/` directory, automatically cleaned up when session is deleted

### Encoding features

- **Video + audio-only modes**: `EncodeConfigDto.type` is `'video'` or `'audio'`; audio-only mode encodes HLS with audio groups only (no video renditions)
- **Trim segments**: Optional `trimSegments` on the encode config restricts the encode to one or more `[in, out]` ranges (each ≥ 0.5 s, non-overlapping). FFmpeg encodes only those ranges and concatenates them in order
- **Streaming pipeline**: `SegmentPipelineService` polls the FFmpeg output directory and streams each new segment through encrypt → upload → byte-range pack with bounded concurrency. This keeps S3 uploads pipelined with FFmpeg progress instead of running serially after the encode completes
- **Adaptive segment format**: Before encoding, `FfmpegService` probes per-stream start times via ffprobe. When all used streams are aligned (spread < 50ms), fMP4 segments (`.m4s` + `init.mp4`) are used for CMAF compatibility and lower overhead. When streams have misaligned start times, MPEG-TS segments (`.ts`) are used as a fallback because the player's TS transmuxer synchronizes audio/video PTS during playback. The chosen format is reported to the client via the `segmentFormat` field in the session status response
- **Byte-range HLS**: When enabled (default), segments are consolidated into fewer large files using HLS byte-range addressing (`#EXT-X-BYTERANGE`), reducing the number of S3 objects. Configurable max file size per consolidated file. Consolidation runs in a non-blocking worker thread (`byte-range.worker.ts`) to avoid blocking the main event loop
- **Copy mode** (`-c:v copy` / `-c:a copy`): Pass-through for pre-encoded streams, avoiding re-encoding
- **VBR encoding**: Video renditions and audio groups support VBR mode (CRF/CQ) instead of fixed bitrate via `vbr` flag
- **Audio groups**: Different audio quality tiers mapped to video renditions via HLS `#EXT-X-MEDIA` GROUP-ID
- **Multi-track audio**: Supports multiple audio tracks (e.g., different languages) with proper `EXT-X-MEDIA` entries including language tags and GROUP-IDs
- **Multi-angle video**: Sources with multiple video tracks produce per-angle HLS playlists via `generateAnglePlaylists`; `videoTrackNames` in config controls angle names
- **Master playlist post-processing**: `fixMasterPlaylist` rewrites FFmpeg's master.m3u8 to inject correct audio group NAMEs and VIDEO group annotations per rendition
- **Metadata**: Language and name attributes in `-var_stream_map` for HLS `#EXT-X-MEDIA` and `#EXT-X-STREAM-INF` tags; rendition `label` for HLS NAME
- **Channel control**: Mono/stereo/5.1/7.1 per audio group via `-ac`
- **Encoder reporting**: Session status includes `encoder` field indicating the acceleration mode used (`cpu`, `nvidia`, or `apple`) and `segmentFormat` field indicating the HLS segment format (`fmp4` or `mpegts`)
- **HLS encryption**: Optional AES-128 encryption for HLS segments via `EncryptionService` (uses worker threads for encryption processing). The encryption key hex is included in the completion webhook payload (`encryptionKeyHex`) and stored in CouchDB by the SaaS Service. Encrypted playback is handled entirely client-side in `HlsPlayer.vue` via blob URL rewriting — fetching playlists from S3, replacing `#EXT-X-KEY` URIs with a blob URL of the key, and serving modified playlists as blob URLs. No server involvement for decryption
- **Thumbnail generation**: `ThumbnailService` generates sprite-based thumbnail previews with a WebVTT file for timeline scrubbing; enabled by default for video encodes via `thumbnails` option in session creation

### Upload resilience

- **Tus protocol**: Resumable, chunked uploads via the Go `tusd` binary wrapped by `node-tusd` (backend) and `tus-js-client` (frontend, 50 MB chunks, 5 parallel uploads, automatic retries)
- **Tusd architecture**: `TusdServer` (from `node-tusd` workspace) spawns the Go `tusd` binary as a child process on an ephemeral port, runs an internal HTTP hook server for lifecycle events, and proxies incoming Express requests to tusd
- **Upload expiration**: Incomplete uploads expire after 10 minutes; expired uploads cleaned up on shutdown via `TusUploadService.onModuleDestroy()` (based on `.info` sidecar file mtime)
- **Bearer auth on tus**: Every tus request is authenticated via the upload token (validated in `onIncomingRequest` hook before proxying to tusd)

### Web client flow

1. User signs in via Auth0 Universal Login (redirect flow); `App.vue` verifies identity with the SaaS Service
2. User navigates to `/sessions/new` (`EncodeView`), selects an S3 config and either a local file or an HTTP/S URL in `SessionConfigForm`
3. On submit, `EncodeView` creates a session (via SaaS Service) and either starts a tus upload (resumable, chunked) or kicks off URL ingestion via `POST /saas/sessions/:id/url-upload`; navigates to `/sessions/:id` (`SessionView`) immediately. The URL-mode UI shows download progress, ETA, and total size
4. `SessionView` handles the full session lifecycle — upload/ingest progress is shown via the `useActiveUploads` singleton composable that survives navigation
5. After upload/ingest completes the Encoding API auto-probes the file; `SessionView` polls or listens via SSE until probe results are available
6. The HLS preview player is available once probe + at least one rendition's worth of segments exist; audio track selector shown when multiple tracks detected
7. `EncodeConfigForm` (from `encode-config` package) computes a suggested encoding config from the probe results on mount; user reviews and configures encoding (renditions, audio groups, copy/VBR toggles, optional trim segments)
8. User clicks "Start Encoding" — `SessionView` strips client-only `audioTrackMetadata` and submits the encode config; saves config to `layoutStorage` for future reuse
9. Real-time encoding progress displayed via SSE (`GET /api/sessions/:id/events`) with `useSessionPoller` as fallback
10. **Chapter editor**: during and after encoding, `SessionView` mounts the `SegmentEditor` (chapters mode) wired to `useChapters`, which loads any existing `chapters.vtt` from S3, autosaves drafts to localStorage, and writes back to S3 (debounced) via the SaaS chapter proxy. The HLS player consumes player-reported duration (not source-probe duration) to keep cue positions aligned with the actual stream
11. On completion, `HlsPlayer` shows a Video.js player for the HLS master playlist; for encrypted sessions, playlists are rewritten client-side (blob URL rewriting of `#EXT-X-KEY` URIs) for seamless playback. Chapter cues are injected from `chapters.vtt`
12. Session history available at `/sessions` (`SessionHistoryView`) with paginated search and filters; external HLS outputs can be imported at `/sessions/import`
13. API keys managed at `/keys` (`ApiKeysView`); S3 configs managed at `/s3-configs` (`S3ConfigsView`)

### FIFO queue

- One encoding job runs at a time
- Sessions processed in first-come-first-served order
- Queue position updates sent via webhook when positions shift

## API Endpoints

Auth on the Encoding API resolves via `AuthResolverGuard`: `master` = `X-API-Key` matching `MASTER_API_KEY`; `apikey` = `X-API-Key` validated via webhook to the SaaS Service; `session` = `Authorization: Bearer sess_*` matching the session's stored token. Each endpoint declares allowed methods via `@AuthTypes(...)`.

### Encoding sessions

| Method | Path | Allowed auth | Description |
|--------|------|--------------|-------------|
| POST | `/api/sessions` | master, apikey | Create encoding session (S3 + webhook + encryption + thumbnail config) |
| ALL | `/api/tus` , `/api/tus/*` | Bearer (session token) | Tus upload endpoint — resumable chunked file upload, auto-probes on completion |
| POST | `/api/sessions/:sessionId/url-upload` | master, apikey, session | Ingest the source file from an HTTP/S URL (parallel Range download, SSRF-guarded). Returns 202; progress reported via SSE |
| POST | `/api/sessions/:sessionId/encode` | master, apikey, session | Submit encoding config (with optional `trimSegments`), enqueue for processing |
| GET | `/api/sessions/:sessionId` | master, apikey, session | Poll session status |
| GET | `/api/sessions/:sessionId/events` | Token (query) | Stream session events via SSE (status, progress, probe results, completion) |
| DELETE | `/api/sessions/:sessionId` | master, apikey, session | Cancel and delete session (any non-terminal status) |
| GET | `/api/sessions/:sessionId/preview/audio-tracks` | Token (query) | Get available audio tracks for preview (with language, name, isDefault) |
| GET | `/api/sessions/:sessionId/preview/playlist.m3u8` | Token (query) | HLS master playlist for preview; supports `?audio=<trackIndex>` |
| GET | `/api/sessions/:sessionId/preview/r:rendition/playlist.m3u8` | Token (query) | HLS rendition media playlist for preview |
| GET | `/api/sessions/:sessionId/preview/r:rendition/:filename` | Token (query) | Stream MPEG-TS preview segment on-demand |

### HLS edit (stateless, takes inline S3 credentials)

| Method | Path | Allowed auth | Description |
|--------|------|--------------|-------------|
| POST | `/api/hls/read` | master, apikey | Fetch and parse a master playlist; returns parsed master + current ETag |
| POST | `/api/hls/mutate` | master, apikey | Apply ordered ops (upsert/remove subtitle, upsert/remove chapters) with If-Match; returns new ETag |
| POST | `/api/hls/discover` | master, apikey | Scan a folder prefix for HLS masters / angle playlists |
| POST | `/api/hls/chapters/read` | master, apikey | Read `chapters/<lang>.vtt` under a folder prefix; 404 when absent |
| POST | `/api/hls/chapters/write` | master, apikey | Write `chapters/<lang>.vtt` under a folder prefix (≤ 1 MiB, `Content-Type: text/vtt`) |

### SaaS Service highlights

The SaaS Service (`/saas/...`) is Auth0-authenticated and exposes user-facing CRUD plus a thin proxy over the Encoding API's HLS-edit endpoints (using the master key on the way out). Notable session routes:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/saas/sessions` | Create session via the Encoding API |
| POST | `/saas/sessions/import` | Import an external HLS output |
| POST | `/saas/sessions/:sessionId/url-upload` | Proxy URL ingestion to the Encoding API |
| PATCH | `/saas/sessions/:sessionId/name` | Rename a stored session |
| POST | `/saas/sessions/:sessionId/move` | Move output files between S3 prefixes |
| POST | `/saas/sessions/:sessionId/rename-prefix` | Rename a session's S3 prefix in place |
| GET | `/saas/sessions/check-prefix` | Check whether a candidate S3 prefix is free |
| POST | `/saas/sessions/:sessionId/hls/read` | Proxy `/api/hls/read` |
| POST | `/saas/sessions/:sessionId/hls/mutate` | Proxy `/api/hls/mutate` |
| GET | `/saas/sessions/:sessionId/chapters` | Proxy `/api/hls/chapters/read` |
| PUT | `/saas/sessions/:sessionId/chapters` | Proxy `/api/hls/chapters/write` |

## Session Lifecycle

```
created -> uploading -> uploaded -> queued -> encoding -> encrypting -> uploading_to_s3 -> completed
                                                      \-> failed
```

## Key Conventions

- DTOs use `class-validator` decorators and are validated via NestJS `ValidationPipe` (whitelist + forbidNonWhitelisted)
- Webhook configuration is optional in `CreateSessionDto` — when omitted, no webhooks are sent; clients can poll instead
- Session-level options (`segmentDuration`, `byteRange`, `byteRangeMaxFileSizeMB`, `thumbnails`, `encryption`) are set at session creation time in `CreateSessionDto`, not in the encode config
- `EncodeConfigDto.trimSegments` is the only way to express trimming — it lives on the encode config submitted at the start of encoding, not on the create-session call
- FFmpeg args are built dynamically based on GPU availability, encode config (audio groups, copy mode, metadata)
- File uploads use the tus protocol via the Go `tusd` binary (wrapped by the `node-tusd` workspace package) with 10 GB max size, mounted via `EncodeModule.onModuleInit()` on `/api/tus`
- URL ingestion is implemented in `UrlFetchService` — same final state machine as tus (`uploading` → `uploaded`) so downstream code is unchanged
- Encoding API authenticates via `AuthResolverGuard` (master key / tenant API key / session Bearer); the SaaS Service still uses Auth0 JWT and proxies HLS-edit / chapter calls to the Encoding API with the master key on outbound
- Both API and SaaS register `ThrottlerModule` globally; long-lived endpoints (SSE, segment streaming, tus, encode lifecycle) annotate `@SkipThrottle()`
- Graceful shutdown enabled (`app.enableShutdownHooks()`); `QueueService`, `FfmpegService`, and `TusUploadService` implement `OnModuleDestroy` to clean up active processes and expired uploads
- Environment config via `dotenv`: `PORT`, `WORK_DIR`, `FFMPEG_TIMEOUT_MS`, `FFMPEG_THREADS`, `CORS_ORIGIN`, `MAX_UPLOAD_SIZE`, `HLS_ENCRYPTION_SEED`, `MASTER_API_KEY`, `KEY_VALIDATION_WEBHOOK_URL`, `AUTHORIZATION_WEBHOOK_URL`, `SESSION_MAX_AGE_HOURS`, `SESSION_CLEANUP_CRON` (API); `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`, `VITE_API_BASE_URL`, `VITE_SAAS_API_BASE_URL` (app); `TUSD_BINARY_PATH` (optional override for tusd binary location); CouchDB, Auth0, and `ENCODING_API_URL` + `ENCODING_API_MASTER_KEY` for the HLS-edit proxy (saas); Auth0 config (admin)
- Swagger decorators on all DTOs and endpoints for auto-generated API docs
- Web client manages S3 configs via the SaaS Service (stored in CouchDB with encrypted credentials); encode configs are persisted via `layoutStorage` (from the `encode-config` package) keyed by media layout fingerprint
- Shared types (ProbeResult, EncodeConfig, VideoRendition, AudioGroup) are defined in `encode-config/src/types.ts` and re-exported by both the encode-config package and `app/src/types.ts`
- Chapter editing uses `useChapters` (app composable) wrapping the `SegmentEditor` from `@luminary-media-converter/segment-editor`; drafts persist in localStorage and autosave to S3 (debounced ~2 s) via the SaaS chapter proxy
- Video.js quality selector is a custom plugin (`videojs-quality-selector.ts`) using native ES6 classes — the `videojs-hls-quality-selector` npm package is incompatible with Video.js 8 (Babel `_inheritsLoose` cannot extend native ES6 classes)
- Vite config uses `resolve.dedupe: ['video.js']` to ensure a single Video.js instance across all modules
- PWA via `vite-plugin-pwa` in `app/vite.config.ts`: web manifest + Workbox service worker precaches same-origin build assets only; `PwaUpdatePrompt.vue` prompts on new deploys (`registerType: 'prompt'`). Offline shell does not make APIs available. Icons in `app/public/`; regenerate with `npm -w app run generate:pwa-icons`

## Source File Preview (COOP/COEP Headers)

The web client includes a local source file preview feature powered by FFmpeg.wasm (multi-threaded). This uses `SharedArrayBuffer` and WORKERFS to mount local files directly without copying them into wasm memory — essential for large files (multi-GB).

`SharedArrayBuffer` requires two HTTP response headers on the page serving the web client:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

**Development:** Already configured in `app/vite.config.ts` via `server.headers`.

**Production:** These headers must be set on the web server or CDN serving the built `app/dist/` files. Examples:

- **Nginx:**
  ```nginx
  location / {
      add_header Cross-Origin-Opener-Policy "same-origin" always;
      add_header Cross-Origin-Embedder-Policy "credentialless" always;
      # ... existing config
  }
  ```

- **Caddy:**
  ```
  header Cross-Origin-Opener-Policy "same-origin"
  header Cross-Origin-Embedder-Policy "credentialless"
  ```

- **Cloudflare Workers (this repo):** `app/public/_headers` is copied into the build output and sets COOP/COEP on all routes plus `Cache-Control: no-cache` on `sw.js`, `workbox-*.js`, and `manifest.webmanifest`
- **Cloudflare Pages / Workers (generic):** Add headers via `_headers` in the static assets directory:
  ```
  /*
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: credentialless
  ```

- **AWS CloudFront:** Add via response headers policy (custom headers).

- **Vercel:** Add via `vercel.json`:
  ```json
  { "headers": [{ "source": "/(.*)", "headers": [
    { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
    { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
  ]}]}
  ```

**Why `credentialless` instead of `require-corp`:** The `credentialless` COEP policy allows cross-origin resources (Auth0 redirects, CDN scripts, S3-hosted media) to load without explicit CORP headers — they just load without cookies. This is compatible with Auth0 Universal Login and third-party scripts. The stricter `require-corp` would break these integrations.

**Without these headers:** `SharedArrayBuffer` is unavailable, WORKERFS mount fails, and FFmpeg.wasm falls back to copying the entire file into wasm memory (MEMFS). This works for small files but fails for large ones (>2GB browser memory limit).

## GPU Detection

At startup, `FfmpegService.onModuleInit()` detects the acceleration mode (`AccelMode`: `'cpu' | 'nvidia' | 'apple'`):

1. **NVIDIA**: `nvidia-smi` available + `ffmpeg -hwaccels` includes `cuda` → `h264_nvenc` encoder, `scale_cuda` filter, `-hwaccel cuda`
2. **Apple Silicon**: `darwin` platform + `arm64` arch + `ffmpeg -hwaccels` includes `videotoolbox` + `ffmpeg -encoders` includes `h264_videotoolbox` + `ffmpeg -filters` includes `scale_vt` → `h264_videotoolbox` encoder, `scale_vt` filter, `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
3. **CPU fallback**: `libx264` encoder, standard `scale` filter

`PreviewService` shares the same GPU detection from `FfmpegService` and uses it for preview transcoding with automatic CPU fallback.

## Scripts

From the repo root:

- `npm run dev` — start all workspaces in dev mode (via `concurrently`): encode-config watch, segment-editor watch, hls watch, API, SaaS, web client, admin
- `npm -w api run start:dev` — API dev server with watch mode
- `npm -w api run build` — compile API to `api/dist/`
- `npm -w api run start:prod` — run compiled API output
- `npm -w api test` — unit tests (Vitest)
- `npm -w api run test:e2e` — end-to-end tests (Vitest, separate config)
- `npm -w app run dev` — web client dev server (Vite, port 5173)
- `npm -w app run build` — production build of the web client
- `npm -w app run test` — web client tests (Vitest)
- `npm -w saas run dev` — SaaS Service dev server with watch mode
- `npm -w saas run build` — compile SaaS Service
- `npm -w saas run test` — unit tests (Vitest)
- `npm -w saas run seed:admin -- <email>` — seed an admin user (or `npm run seed:admin -- <email>` from root)
- `npm -w admin run dev` — admin panel dev server (Vite)
- `npm -w admin run build` — production build of the admin panel
- `npm -w admin run test` — admin panel tests (Vitest)
- `npm -w encode-config run build` — build encode-config library
- `npm -w encode-config run dev` — watch build encode-config library
- `npm -w segment-editor run build` — build segment-editor library
- `npm -w segment-editor run dev` — watch build segment-editor library
- `npm -w segment-editor run test` — segment-editor tests (Vitest)
- `npm -w hls run build` — build hls library
- `npm -w hls run dev` — watch build hls library
- `npm -w hls run test` — hls library tests (Vitest)
- `npm -w tusd run build` — build tusd wrapper library
- `npm -w tusd run download-tusd` — download the tusd Go binary for the current platform
