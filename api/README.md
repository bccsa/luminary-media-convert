# Luminary Encoding API

The encoding service behind Luminary Media Convert. A NestJS application that probes media with ffprobe, encodes it to HLS/ABR with FFmpeg (GPU-accelerated when NVIDIA or Apple Silicon hardware is available), optionally encrypts it with AES-128, streams the output to any S3-compatible storage, and reports progress over SSE or polling.

It runs two ways from one code path:

- **Embedded** — `createServer(options)` from `src/bootstrap.ts`. The Electron shell hosts it in its main process and passes the API token, origin policy, credential cipher, window hook, ffmpeg paths and static client directory directly.
- **Standalone** — `src/main.ts` calls the same function with values read from the environment, and turns on Swagger at `/api/docs`.

It binds to **loopback only** (`127.0.0.1`). Nothing here is meant to be reachable from the network the machine is on: CORS and tokens are answers to questions a remote caller only gets to ask if it can open the socket. The default embedded port is `31711`; standalone defaults to `3000`.

## Table of Contents

- [Authentication](#authentication)
- [Origin gating and Local Network Access](#origin-gating-and-local-network-access)
- [Environment Variables](#environment-variables)
- [Embedding the API](#embedding-the-api)
- [Endpoints](#endpoints)
    - [1. Create a session](#1-create-a-session)
    - [2. Attach a local file](#2-attach-a-local-file)
    - [3. Poll session status](#3-poll-session-status)
    - [4. Start encoding](#4-start-encoding)
    - [5. Delete a session](#5-delete-a-session)
    - [CMS handshake](#cms-handshake)
    - [HLS edit](#hls-edit)
- [Encoding Workflow](#encoding-workflow)
- [Credential Handling](#credential-handling)
- [Encrypted HLS and the `luminary://key` contract](#encrypted-hls-and-the-luminarykey-contract)
- [GPU Acceleration](#gpu-acceleration)
- [S3 Compatibility](#s3-compatibility)
- [HLS Output Structure](#hls-output-structure)
- [Disk Guards and Session Sweeping](#disk-guards-and-session-sweeping)
- [Error Handling](#error-handling)
- [Development](#development)

---

## Authentication

There is no identity provider, no key store and no external validation webhook. Three credential tiers, resolved in order by `AuthResolverGuard`. Endpoints declare what they accept with `@AuthTypes(...)`, defaulting to `['master']`.

| Credential         | Form                                                                                       | Held by                         | Scope                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instance API token | `X-API-Key: <token>`                                                                       | The app's own UI                | Everything — it is accepted regardless of an endpoint's `@AuthTypes`. Minted per launch by the Electron main process and handed to the renderer over the preload bridge; standalone it comes from `MASTER_API_KEY` |
| Session token      | `Authorization: Bearer sess_*`, or `?token=` on the preview / waveform / storyboard routes | The UI, per session             | One session: attach a file, encode, poll, delete, chapters, preview                                                                                                                                                |
| Read token         | `?token=read_*`                                                                            | The CMS that opened the session | Watch only: the SSE stream and the status endpoint. Cannot start, cancel, or reach the source file. Minted only for CMS-created sessions                                                                           |

A request that presents an `X-API-Key` which does not match is rejected outright — it does not fall through to the other tiers. When no token is configured at all, key auth is effectively disabled and every keyed endpoint refuses.

## Origin gating and Local Network Access

`/api/cms/*` is not key-authenticated. There is no credential a page in a browser could hold that the pages around it could not also read, so the question worth asking is _which site is calling_ — and that is the one thing the browser answers honestly.

- `OriginRegistry` holds an allowlist. Origins are normalised (lower-cased, no trailing slash) and compared exactly.
- Standalone, the allowlist is `CMS_ALLOWED_ORIGINS` (comma-separated) and there is no approver: an unknown origin is simply refused.
- Embedded, the host also supplies an `originApprover`. The Electron shell shows a native dialog, remembers both allows and denies in its settings file, and serialises dialogs so two requests milliseconds apart cannot stack two modal sheets over one decision.
- After binding, the server approves its own address, so a packaged app never asks the user whether to trust itself.
- CORS refusal is expressed by withholding the header, not by raising — the browser reports an ordinary CORS block instead of the API returning 500 to something it deliberately turned away.
- A public page reaching `127.0.0.1` is a private-network request: `privateNetworkAccessMiddleware` answers Chrome's Local Network Access preflight with `Access-Control-Allow-Private-Network: true`. That is a grant of _reachability_ only; who may talk to the API is still the allowlist's decision on the same response.
- A request with **no** `Origin` (curl, or a renderer whose origin browsers report inconsistently) is accepted only from a loopback peer.

---

## Environment Variables

Only relevant when running standalone — the embedding host passes these in code.

| Variable                          | Required            | Default             | Description                                                               |
| --------------------------------- | ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `MASTER_API_KEY`                  | for keyed endpoints | —                   | The instance API token accepted on `X-API-Key`                            |
| `PORT`                            | No                  | `3000`              | HTTP port (the embedded default is `31711`)                               |
| `HOST`                            | No                  | `127.0.0.1`         | Bind address                                                              |
| `WORK_DIR`                        | No                  | `./work`            | Scratch directory for sessions, previews and sidecars                     |
| `CMS_ALLOWED_ORIGINS`             | No                  | —                   | Comma-separated origins allowed to use `/api/cms/*`                       |
| `FFMPEG_PATH`                     | No                  | PATH lookup         | Absolute path to the ffmpeg executable                                    |
| `FFPROBE_PATH`                    | No                  | PATH lookup         | Absolute path to the ffprobe executable                                   |
| `FFMPEG_TIMEOUT_MS`               | No                  | none                | Max FFmpeg runtime before a forced kill                                   |
| `FFMPEG_THREADS`                  | No                  | —                   | Thread count passed to FFmpeg                                             |
| `DISK_RESERVE_BYTES`              | No                  | `2147483648` (2 GB) | Free space kept in hand on the work volume                                |
| `SESSION_ABANDONED_MAX_AGE_HOURS` | No                  | `6`                 | How long an idle session may sit before it is swept                       |
| `SESSION_CLEANUP_CRON`            | No                  | `0 * * * *`         | Sweep schedule                                                            |
| `S3_UPLOAD_STALL_TIMEOUT_MS`      | No                  | `300000`            | Stall detector for S3 uploads (judged on bytes sent, not files completed) |

Example `api/.env`:

```bash
MASTER_API_KEY=dev-token
PORT=3000
CMS_ALLOWED_ORIGINS=http://localhost:5199
```

---

## Embedding the API

```ts
import { createServer, DEFAULT_PORT, ALLOWED_EXTENSIONS } from '@luminary-media-converter/api';

const server = await createServer({
    port: DEFAULT_PORT,          // 31711
    host: '127.0.0.1',           // default
    workDir: '/path/to/work',
    localApiToken: token,        // accepted on X-API-Key
    cmsAllowedOrigins: [...],    // trusted without asking
    originApprover: async (origin) => /* ask the user */ true,
    credentialCipher: { encrypt, decrypt },   // e.g. Electron safeStorage
    onCmsSessionCreated: (sessionId) => focusWindow(),
    ffmpegPath, ffprobePath,     // omit to use PATH
    staticAppDir: '/path/to/app/dist',        // served at /
    enableSwagger: false,
});

// server: { app, port, url, close() }
```

`workDir` and the ffmpeg paths are written into `process.env` before Nest instantiates anything, because that is how the services already read them and each is a value the whole process shares. The token, cipher, origin policy and window hook are per-host objects and go through injection tokens bound by the global `RuntimeOptionsModule`. Always construct the app through `AppModule.forRoot(...)`; importing `AppModule` bare leaves those tokens unbound.

`ALLOWED_EXTENSIONS` is re-exported so a host's file picker offers exactly the extensions the API will accept — two lists that drifted apart would show a user a file and then refuse it.

---

## Endpoints

Interactive OpenAPI docs at `/api/docs` when Swagger is enabled.

| Method    | Path                                                                         | Auth                        | Description                                                         |
| --------- | ---------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| POST      | `/api/sessions`                                                              | token                       | Create a session                                                    |
| GET       | `/api/sessions`                                                              | token                       | List every session, newest first (includes session tokens)          |
| POST      | `/api/sessions/:id/local-file`                                               | token, session              | Attach a file already on this machine                               |
| POST      | `/api/sessions/:id/encode`                                                   | token, session              | Submit the encode config and enqueue                                |
| GET       | `/api/sessions/:id`                                                          | token, session, read        | Poll status                                                         |
| GET       | `/api/sessions/:id/events`                                                   | `?token=` (session or read) | SSE event stream                                                    |
| DELETE    | `/api/sessions/:id`                                                          | token, session              | Cancel and delete (not while `encrypting` / `uploading_to_s3`)      |
| GET / PUT | `/api/sessions/:id/chapters`                                                 | token, session              | Read / write `chapters/<lang>.vtt` in the session's own prefix      |
| GET       | `/api/sessions/:id/waveform`                                                 | `?token=`                   | Waveform peaks for the source                                       |
| GET       | `/api/sessions/:id/preview/**`                                               | `?token=`                   | On-demand preview master / rendition playlists and MPEG-TS segments |
| GET       | `/api/sessions/:id/thumbnails/**`                                            | `?token=`                   | Pre-encode source storyboard VTT and sprite sheets                  |
| GET       | `/api/cms/health`                                                            | none                        | Liveness probe for the CMS                                          |
| POST      | `/api/cms/sessions`                                                          | Origin                      | Open (or reuse) a session for a CMS document                        |
| POST      | `/api/hls/{read,mutate,discover,chapters/read,chapters/write,waveform/read}` | token                       | Stateless HLS-edit operations against inline S3 credentials         |

### 1. Create a session

```
POST /api/sessions
X-API-Key: <instance token>
Content-Type: application/json
```

```json
{
    "s3": {
        "endPoint": "minio.example.com",
        "port": 9000,
        "useSSL": false,
        "bucket": "media-output",
        "region": "us-east-1",
        "accessKey": "YOUR_ACCESS_KEY",
        "secretKey": "YOUR_SECRET_KEY",
        "pathPrefix": "videos/my-project"
    },
    "encryption": { "enabled": true },
    "segmentDuration": 6,
    "byteRange": true,
    "byteRangeMaxFileSizeMB": 500,
    "audioByteRangeMaxFileSizeMB": 50,
    "thumbnails": true
}
```

Everything but `s3` is optional. `segmentDuration` defaults to 6 s, `byteRange` to true, `byteRangeMaxFileSizeMB` to 500, `thumbnails` to true for video encodes. `audioByteRangeMaxFileSizeMB` (default 50) caps the shared audio chunk chain, which carries **every** audio group — minutes of content per chunk ≈ cap ÷ (audio stream count × bitrate), so a wide multi-language ladder should raise it. `encryption` omitted means no encryption; `encryption.keyUrl` overrides the `luminary://key` placeholder written into `#EXT-X-KEY`.

**Response (201):**

```json
{
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "sessionToken": "sess_f8e7d6c5b4a3291087654321"
}
```

### 2. Attach a local file

The source is used **where it is** — never copied and never moved, so a multi-gigabyte pick costs no disk and no wait. The file belongs to the user throughout: nothing here writes to it or removes it, including on failure.

```
POST /api/sessions/:sessionId/local-file
Authorization: Bearer <sessionToken>
Content-Type: application/json

{ "path": "/Users/me/Movies/episode-12.mov" }
```

The path must be absolute (a relative path would resolve against the encoder's working directory, not where the user was standing), must be a regular file, and must carry an allowed media extension. The call returns the session status once the file has been probed — status `uploaded`, with `probeResult` attached.

**`201`** on success; **`400`** when the path is missing, not a file, not a media file, or the session is past `created`.

### 3. Poll session status

```
GET /api/sessions/:sessionId
X-API-Key: <instance token>
# or: Authorization: Bearer <sessionToken>
# or: ?token=<session or read token>
```

| Status            | Description                             | Extra fields                                                                     |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `created`         | Session created, awaiting a source file | —                                                                                |
| `uploading`       | Source ingest in progress               | `progress`, `ingestTotalBytes`                                                   |
| `uploaded`        | Source in place and probed              | `probeResult`                                                                    |
| `queued`          | Waiting in the FIFO queue               | `queuePosition`                                                                  |
| `encoding`        | FFmpeg running                          | `progress`, `pipelineProgress`, `hlsUrl`, `encryptionKeyHex`                     |
| `encrypting`      | Segment encryption                      | `progress`, `pipelineProgress`                                                   |
| `uploading_to_s3` | Output going to the bucket              | `progress`, `pipelineProgress`                                                   |
| `completed`       | Done                                    | `files`, `masterPlaylist`, `thumbnailsVtt`, `segmentFormat`                      |
| `failed`          | Error                                   | `error`, and `canRetry` when the source and credentials are both still available |

`hlsUrl` and `encryptionKeyHex` appear from the moment encoding starts, not at completion — a caller that reconnects mid-encode has to be able to ask for them again. `title`, `documentId`, `encoder` and any submitted `trimSegments` are always reported.

### 4. Start encoding

```
POST /api/sessions/:sessionId/encode
Authorization: Bearer <sessionToken>
Content-Type: application/json
```

Video:

```json
{
    "type": "video",
    "videoRenditions": [
        {
            "width": 1920,
            "height": 1080,
            "videoBitrateKbps": 5000,
            "copyStream": false,
            "audioGroupId": "hd",
            "label": "1080p",
            "vbr": true
        },
        {
            "width": 1280,
            "height": 720,
            "videoBitrateKbps": 2500,
            "copyStream": false,
            "audioGroupId": "hd",
            "label": "720p",
            "vbr": true
        }
    ],
    "audioGroups": [
        {
            "id": "hd",
            "label": "HD Audio",
            "audioBitrateKbps": 256,
            "channels": 2,
            "audioCodec": "aac",
            "sourceTrackIndex": 0,
            "language": "eng",
            "vbr": true
        }
    ],
    "trimSegments": [{ "inSec": 12.0, "outSec": 300.5 }]
}
```

Audio-only:

```json
{
    "type": "audio",
    "audioGroups": [
        {
            "id": "hd",
            "label": "High Quality",
            "audioBitrateKbps": 192,
            "channels": 2,
            "audioCodec": "aac",
            "sourceTrackIndex": 0,
            "vbr": true
        },
        {
            "id": "low",
            "label": "Bandwidth Saving",
            "audioBitrateKbps": 64,
            "channels": 2,
            "audioCodec": "aac",
            "sourceTrackIndex": 0,
            "vbr": true
        }
    ]
}
```

Validated on the way in: a video encode needs at least one rendition and one audio group, every rendition's `audioGroupId` must name a group that exists, and a `copyStream` rendition needs a `sourceTrackIndex`. `trimSegments` is the only way to express trimming, and it lives here rather than on the session.

The session must be `uploaded`, **or** `failed` with its source file still on disk (a retry). A session restored without its S3 credentials is refused here rather than burning the whole encode and failing at the upload with an opaque authentication error.

**Response (202):** `{ "sessionId": "…", "status": "queued", "queuePosition": 1 }`

### 5. Delete a session

```
DELETE /api/sessions/:sessionId
```

`204 No Content`. Allowed from `created`, `uploading`, `uploaded`, `queued`, `encoding`, `failed` and `completed` — the terminal two included, which is the only way their disk is ever reclaimed. `encrypting` and `uploading_to_s3` are refused, because the pipeline is mid-write and pulling its files out from under it leaves half an output in the bucket. Queued sessions are dequeued, encoding sessions have their FFmpeg process killed, and the whole work directory (session record, preview cache, sidecars, credential sidecar) is removed.

### CMS handshake

`GET /api/cms/health` → `{ "status": "ok", "apiVersion": "0.0.1" }`, unauthenticated. A probe that says only "something is listening on this port, and it is us" gives away nothing, and the CMS needs it before it can decide whether to show the affordance at all.

`POST /api/cms/sessions`, gated by Origin:

```json
{
    "documentId": "post_01HTZ8Y0J4",
    "title": "Episode 12 — The Long Way Round",
    "s3": { "…": "…" },
    "publicBaseUrl": "https://cdn.example.com/media",
    "encryption": { "required": true },
    "existingMedia": { "hlsUrl": "…", "hlsKey": "…" }
}
```

→

```json
{
    "sessionId": "…",
    "readToken": "read_…",
    "eventsUrl": "http://127.0.0.1:31711/api/sessions/<id>/events?token=read_…",
    "apiVersion": "0.0.1",
    "reused": false
}
```

- The response carries identifiers and a read token, **never** the storage credentials it was sent.
- `documentId` is an idempotency key: a repeat click returns the session already in flight (`reused: true`) instead of starting a second encode against the same post. Finished sessions do not match — that click means "replace what is there".
- Every session writes to its own subfolder, `<pathPrefix>/<sessionId>`, so a replacement cannot be half-live while the second encode runs.
- `existingMedia` is validated and stored for a future edit mode; nothing acts on it today.
- Creating or reusing a session fires the host's session hook, which brings the desktop window forward — the user has a file to choose.

The CMS then subscribes to `eventsUrl`. The first `encoding` event carries `hlsUrl` and `encryptionKeyHex` together; that pair is what the CMS saves against its document.

### HLS edit

Stateless operations against inline S3 credentials, used for post-encode edits:

| Path                           | Description                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/hls/read`           | Fetch and parse a master playlist; returns the parsed master + current ETag                                                        |
| `POST /api/hls/mutate`         | Apply ordered operations (upsert/remove subtitle, upsert/remove chapters) with `If-Match`; returns the new ETag. `409` on mismatch |
| `POST /api/hls/discover`       | Scan a folder prefix for HLS masters / angles                                                                                      |
| `POST /api/hls/chapters/read`  | Read `chapters/<lang>.vtt`; `404` when absent                                                                                      |
| `POST /api/hls/chapters/write` | Write `chapters/<lang>.vtt` (≤ 1 MiB, `text/vtt`)                                                                                  |
| `POST /api/hls/waveform/read`  | Read `waveform.json`; `404` when absent                                                                                            |

The session-scoped `GET`/`PUT /api/sessions/:id/chapters` routes are the same operations with the bucket and prefix resolved from the session, so the caller supplies nothing but a language.

---

## Encoding Workflow

1. **Session creation** — S3 destination plus segment / byte-range / thumbnail / encryption options. Returns a session token.
2. **Source attach** — an absolute path to a file already on the machine. `IngestService` then runs the shared post-ingest pipeline: record the path → ffprobe → initialise the preview → status `uploaded` → prime the waveform cache and source storyboard in the background.
3. **Configure** — the client reads the probe results, computes a suggested config, and lets the user adjust renditions, audio groups, copy/VBR and trim ranges. An on-demand HLS preview is available throughout.
4. **Queue** — FIFO, one encode at a time.
5. **Encode** — the AES key and IV are generated _before_ the status flips to `encoding`, and `hlsUrl` is published at the same moment, so anything watching that transition is handed both. FFmpeg probes per-stream start times and aligns misaligned streams with an input seek to the latest start; output is always fMP4. `SegmentPipelineService` streams each new segment through encrypt → upload → byte-range pack with bounded concurrency, so S3 uploads keep pace with FFmpeg rather than running serially afterwards.
6. **Finish** — `#EXT-X-KEY` tags injected, thumbnail sprites + `thumbnails.vtt` generated for video encodes, `waveform.json` written beside `master.m3u8`, and the completion event lists every object key.

### Session lifecycle

```
created -> uploading -> uploaded -> queued -> encoding -> encrypting -> uploading_to_s3 -> completed
                                                       \-> failed
```

A `failed` session whose source is still on disk and whose credentials are still usable reports `canRetry: true` and can be encoded again without re-ingesting.

---

## Credential Handling

S3 credentials arrive per session and must survive a restart without ever sitting in plaintext on disk.

- `session.json` in the session's work directory **never** holds S3 keys, cipher or no cipher: they are written as `<redacted>`. A file on the user's disk is exactly the place a stolen credential is found, and nothing reading the session record needs them.
- Given a `CredentialCipher`, the keys go in a `credentials.enc` sidecar. The Electron implementation wraps `safeStorage`, whose key lives in the OS keychain.
- Without a cipher, nothing is written: the API warns once that credentials are memory-only and sessions will not survive a restart. A stranded session is a far smaller problem than a plaintext key in the work directory.
- Both files are written `0o600` and swapped into place via `.tmp` + rename.
- At boot, terminal sessions are purged, in-flight sessions become `failed` ("the encoder restarted"), and any session whose credentials could not be recovered becomes `failed` with an explanation. Every path that would reach S3 checks `hasUsableCredentials()` first.

---

## Encrypted HLS and the `luminary://key` contract

Keys are generated locally (`randomBytes(16)`) and never leave the machine, so there is nothing to serve them over HTTP. With no explicit `keyUrl`, `#EXT-X-KEY` carries the sentinel `luminary://key` (`LUMINARY_KEY_PLACEHOLDER_URI`, exported from `@luminary-media-converter/hls-core`). A player is expected to recognise it and swap in the key it already holds — the hex reported as `encryptionKeyHex` on the session and on the SSE stream — typically by rewriting the playlist and pointing the URI at a blob URL of the raw bytes. `app/src/components/HlsPlayer.vue` is the reference implementation.

Multi-angle output is a single spec-correct master: each angle is an `#EXT-X-MEDIA:TYPE=VIDEO` group and every `#EXT-X-STREAM-INF` carries `VIDEO="<group>"`. Players that want to pin one angle, or drop video entirely, narrow the playlist client-side with `listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist` from the same package.

---

## GPU Acceleration

Detected once at startup, NVIDIA first, then Apple Silicon, then CPU.

### NVIDIA (Linux / Windows)

`nvidia-smi` available and `ffmpeg -hwaccels` includes `cuda`.

- **Decoder**: `-hwaccel cuda -hwaccel_output_format cuda`
- **Encoder**: `h264_nvenc`
- **Scaler**: `scale_cuda` (frames stay in GPU memory)

### Apple Silicon (macOS M1+)

Platform `darwin`, arch `arm64`, and FFmpeg supporting `videotoolbox`, `h264_videotoolbox` and `scale_vt`.

- **Decoder**: `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
- **Encoder**: `h264_videotoolbox`
- **Scaler**: `scale_vt`

### CPU fallback

`libx264` with resolution-based presets. Audio always encodes on CPU.

The active mode is logged at startup and reported as the `encoder` field on status responses and SSE events. `PreviewService` shares the same detection. This is why packaged builds ship their own ffmpeg — hardware support is a compile-time decision, and a user's own build may have none of it.

---

## S3 Compatibility

Uploads go through the MinIO JavaScript client, which works with MinIO, Cloudflare R2, AWS S3, Backblaze B2, DigitalOcean Spaces and anything else speaking S3. Credentials are per session, so different sessions can target different buckets or providers.

Every object key is built from `S3Service.canonicalPrefix()` — no leading, trailing or doubled slashes, whatever the caller typed.

---

## HLS Output Structure

Output is **always fMP4** (`.m4s` + a per-stream init, CMAF-compatible). A source whose streams start at different times (≥ 20 ms apart) is aligned by an input seek to the latest-starting stream's start — every stream loses the same leading fraction of a second, timestamps stay honest, and lip-sync is preserved. `segmentFormat` is reported as `"fmp4"`; `"mpegts"` appears only on sessions restored from before this change.

Copy-mode video is gated by the source: the track must not be early-starting on a misaligned source (an input seek cuts copied streams at keyframe granularity, leaving permanent desync) and its keyframe cadence must be regular and divide the segment duration exactly (compared in frames, so NTSC rates pass). An unqualified track is refused at encode submit with a message naming it; the form disables its Copy toggle with the same reason.

With byte-range mode on (the default), segments are packed into **shared chunk chains** under `media/`: one chain per video angle carrying every rendition of that angle (segments interleaved by arrival), and one audio chain carrying every audio group. On a delivery edge that forwards a requested range while backhauling the whole object, one backhaul warms every quality of the playing angle, so an ABR step-up never lands on a cold object. The first chunk of each chain closes at ~20 s of content (fast edge warm-up at play-start); every later chunk is cap-sized — `byteRangeMaxFileSizeMB` for video chains, `audioByteRangeMaxFileSizeMB` for the audio chain. Media playlists stay in their stream directories and reference the chunks as `../media/…` with `#EXT-X-BYTERANGE`.

```
{pathPrefix}/{sessionId}/          # CMS sessions get a per-session subfolder
├── master.m3u8
├── waveform.json
├── media/
│   ├── v0_0.m4s                   # angle 0 chain: every rendition of that angle
│   ├── v0_1.m4s
│   ├── v1_0.m4s                   # angle 1 chain (multi-angle sources)
│   └── a_0.m4s                    # audio chain: every audio group
├── stream_1080p_1920x1080/
│   ├── init_0.mp4                 # ffmpeg names the init; #EXT-X-MAP matches it
│   └── playlist.m3u8
├── stream_720p_1280x720/
│   └── …
├── stream_HD/
│   └── …
├── thumbnails/
│   ├── thumbnails.vtt
│   └── sprite_*.jpg
└── chapters/
    └── en.vtt                     # written by the chapter editor, when used
```

Stream directory names derive from the rendition labels. Players can warm the next chunk ahead of the boundary — see `docs/chunk-warming.md`; `@luminary-media-converter/player-web` implements it.

---

## Disk Guards and Session Sweeping

- `disk-space.ts` refuses an ingest or an encode that would not fit, keeping `DISK_RESERVE_BYTES` (2 GB by default) in hand. Checked _before_ the transfer, so a doomed ingest does not cost the user the whole transfer first.
- `SessionCleanupService` sweeps hourly and removes only genuinely idle sessions — `created`, `uploading`, `uploaded` — that have shown no activity for `SESSION_ABANDONED_MAX_AGE_HOURS`. Queued and encoding sessions are left alone.
- Abandonment is judged on `lastActivityAt`, not `createdAt`: a slow multi-gigabyte ingest is hours old and perfectly alive, while a tab closed on the config screen is hours old and never coming back.
- Finished sessions are discarded at boot along with their work directory, so no age threshold has to stand in for "the user is done looking at this".

---

## Error Handling

- **Process isolation**: FFmpeg runs as a child process. Crashes, timeouts and errors never take the service down.
- **Queue resilience**: a failed job is marked `failed` with its error and the queue moves on.
- **Graceful shutdown**: `enableShutdownHooks()` plus `OnModuleDestroy` on `QueueService` and `FfmpegService`. The Electron host defers quitting until `server.close()` resolves — quitting out from under Nest leaves orphan ffmpeg processes and half-written output.
- **User files are never touched**: a probe that could not read a source file fails the session, not the file.

---

## Development

```bash
npm -w api run dev          # watch mode
npm -w api run build
npm -w api run start:prod   # node dist/main
npm -w api test             # unit tests (Vitest)
npm -w api run test:e2e     # end-to-end tests
```

Many specs were intentionally left broken during the local-only migration and are tracked for restoration in the [issues](https://github.com/bccsa/luminary-media-convert/issues).

## Tech Stack

- Node.js with TypeScript (ES2023, `nodenext` modules)
- NestJS 11 (Express platform), embeddable via `createServer()`
- Token-based auth (instance token + session tokens + read tokens) and an Origin allowlist for CMS callers
- helmet CSP, per-request CORS, Local Network Access preflight support
- FFmpeg / ffprobe via `child_process`, GPU-accelerated when available
- MinIO JS client for S3
- `class-validator` + `class-transformer` for DTO validation
- Swagger/OpenAPI at `/api/docs` when enabled
- Vitest for testing
