# api/ — Encoding API

## Overview

- **`api/`** — NestJS REST API service (the "Encoding API") that encodes media files into HLS/ABR format using FFmpeg (with optional NVIDIA or Apple Silicon GPU acceleration), uploads output to S3-compatible storage, and delivers status updates via SSE or polling. Also provides on-demand HLS preview streaming before/during encoding, a source storyboard and waveform for the trim timeline, a CMS handshake API, and a stateless HLS-edit API for mutating master playlists and reading/writing chapter and waveform sidecars in S3. Exposed as a library (`createServer()` in `api/src/bootstrap.ts`) so the desktop shell can host it in-process; `api/src/main.ts` is the same code path run standalone from the environment.

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
- **Testing**: Vitest (`*.spec.ts` colocated in `api/src/`, e2e in `api/test/`). Note: some specs were intentionally left broken during the migration — see the open issues

## Detail (read on demand, not loaded automatically)

- `docs/claude/api-architecture.md` — sessions, CMS contract, trust model, LNA/PNA, credentials, pipeline, features, preview, persistence, lifecycle
- `docs/claude/api-reference.md` — endpoints and environment variables
- `docs/claude/api-conventions.md` — key conventions
- `docs/claude/api-structure.md` — file layout
- `docs/claude/ffmpeg.md` — FFmpeg requirement and GPU detection
- `docs/claude/development.md` — dev workflows and the CMS flow
