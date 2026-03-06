# Luminary Media Convert

HLS/ABR media encoding service built with NestJS. Accepts encoding requests via REST API, processes media files with FFmpeg (GPU-accelerated when NVIDIA or Apple Silicon hardware is available), uploads HLS output to any S3-compatible storage, and delivers status updates via webhooks or polling.

The repository is an npm workspaces monorepo containing:

- **`api/`** — NestJS encoding service (REST API, tus upload, FFmpeg, S3 upload, webhooks)
- **`app/`** — Vue 3 web client for uploading and monitoring encoding sessions
- **`encode-config/`** — Shared Vue 3 component library (`EncodeConfigForm`, encoding types, layout-based config persistence)

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Auth0 Setup](#auth0-setup)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Web Client](#web-client)
- [API Documentation](#api-documentation)
  - [1. Create an Encoding Session](#1-create-an-encoding-session)
  - [2. Upload the Source File (tus)](#2-upload-the-source-file-tus)
  - [3. Poll Session Status](#3-poll-session-status)
  - [4. Start Encoding](#4-start-encoding)
- [Webhook Callbacks](#webhook-callbacks)
- [Encoding Workflow](#encoding-workflow)
- [GPU Acceleration](#gpu-acceleration)
- [S3 Compatibility](#s3-compatibility)
- [HLS Output Structure](#hls-output-structure)
- [Error Handling](#error-handling)

---

## Architecture Overview

```
Client           Auth0          Luminary Service                External
──────           ─────          ────────────────                ────────
  │                │                   │                           │
  │  Login ──────>│                   │                           │
  │<── JWT token  │                   │                           │
  │                                   │                           │
  │  1. POST /api/sessions            │                           │
  │  (Bearer JWT + config) ─────────>│                           │
  │                                   │── validate JWT via JWKS   │
  │<── { sessionId,                   │                           │
  │      tusEndpoint,                 │                           │
  │      uploadToken }                │                           │
  │                                   │                           │
  │  2. tus upload to /api/tus        │                           │
  │  (Bearer uploadToken) ─────────>│                           │
  │  (resumable, chunked)             │── auto-probe on complete  │
  │                                   │                           │
  │  3. GET /api/sessions/:id         │                           │
  │  (Bearer JWT, polling) ─────────>│                           │
  │<── { status: uploaded,            │                           │
  │      probeResult }                │                           │
  │                                   │                           │
  │  4. POST /api/sessions/:id/encode │                           │
  │  (Bearer JWT + encodeConfig) ──>│                           │
  │<── 202 { queued }                 │                           │
  │                                   │                           │
  │                                   │── webhook: { queued } ──>│ Webhook
  │                                   │── FFmpeg encode ──┐      │ Endpoint
  │                                   │<── progress ──────┘      │
  │                                   │── webhook: { 45% } ────>│
  │                                   │                           │
  │                                   │── upload to S3 ────────>│ S3
  │                                   │── webhook: { completed } >│ Storage
  │                                   │                           │
  │  5. GET /api/sessions/:id         │                           │
  │  (Bearer JWT, polling) ─────────>│                           │
  │<── { status, progress, ... }     │                           │
```

## Prerequisites

- **Node.js** >= 18
- **Auth0 account** with an API and a Single Page Application configured (see [Auth0 Setup](#auth0-setup))
- **FFmpeg** with the following encoders/filters:
  - CPU: `libx264`, `aac`
  - NVIDIA GPU (optional): `h264_nvenc`, `scale_cuda` (requires NVIDIA GPU + CUDA drivers)
  - Apple Silicon GPU (optional): `h264_videotoolbox` (requires macOS on Apple M1+ hardware)

### Installing FFmpeg

**macOS (Homebrew):**

```bash
brew install ffmpeg
```

**Ubuntu/Debian:**

```bash
sudo apt update && sudo apt install -y ffmpeg
```

**With NVIDIA GPU support (Linux):**

```bash
# Ensure NVIDIA drivers and CUDA toolkit are installed
# FFmpeg must be compiled with --enable-nvenc --enable-cuda
# See: https://docs.nvidia.com/video-technologies/video-codec-sdk/
```

**Apple Silicon (macOS, M1+):**

VideoToolbox hardware encoding is available automatically when FFmpeg is built with VideoToolbox support (the default for Homebrew FFmpeg on Apple Silicon). No extra configuration is needed.

## Auth0 Setup

Authentication is handled by [Auth0](https://auth0.com). You need to create two resources in the Auth0 dashboard:

### 1. Create an API

1. Go to **Applications > APIs** and click **Create API**.
2. Set a **Name** (e.g. `Luminary Media Convert`) and an **Identifier** (e.g. `https://luminary-media-convert/api`). The identifier becomes your `AUTH0_AUDIENCE`.
3. Leave **Signing Algorithm** as `RS256`.

### 2. Create a Single Page Application

1. Go to **Applications > Applications** and click **Create Application**.
2. Choose **Single Page Web Applications**.
3. In the application **Settings**, note the **Domain** and **Client ID** — these become `VITE_AUTH0_DOMAIN` and `VITE_AUTH0_CLIENT_ID`.
4. Under **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**, add your web client URL (e.g. `http://localhost:5173` for development).

## Environment Variables

### API (`api/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `AUTH0_DOMAIN` | **Yes** | — | Auth0 tenant domain (e.g. `your-tenant.auth0.com`) |
| `AUTH0_AUDIENCE` | **Yes** | — | Auth0 API identifier / audience |
| `WORK_DIR` | No | `./work` | Directory for temporary files during encoding |
| `FFMPEG_TIMEOUT_MS` | No | `0` (none) | Max time for FFmpeg process before forced kill |
| `FFMPEG_THREADS` | No | `8` | Number of threads for FFmpeg encoding |
| `MAX_UPLOAD_SIZE` | No | `10737418240` (10 GB) | Maximum upload file size in bytes |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin for the web client |

Example `api/.env`:

```bash
PORT=3000
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://luminary-media-convert/api
CORS_ORIGIN=http://localhost:5173
```

### Web Client (`app/.env`)

| Variable | Required | Description |
|---|---|---|
| `VITE_AUTH0_DOMAIN` | **Yes** | Auth0 tenant domain (same as API) |
| `VITE_AUTH0_CLIENT_ID` | **Yes** | Auth0 SPA application Client ID |
| `VITE_AUTH0_AUDIENCE` | **Yes** | Auth0 API identifier (same as API) |
| `VITE_API_BASE_URL` | **Yes** | API base URL (e.g. `http://localhost:3000`) |

Example `app/.env`:

```bash
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-spa-client-id
VITE_AUTH0_AUDIENCE=https://luminary-media-convert/api
VITE_API_BASE_URL=http://localhost:3000
```

## Getting Started

```bash
# Install all dependencies (hoisted to root via npm workspaces)
npm install

# Start both the API and web client in development mode
npm run dev
```

This runs the encode-config library in watch mode, the NestJS API on `http://localhost:3000`, and the Vue web client on `http://localhost:5173`.

To start workspaces individually:

```bash
# API only (watch mode)
npm -w api run start:dev

# Web client only
npm -w app run dev

# Encode config library (watch build)
npm -w encode-config run dev

# API production build
npm -w api run build
npm -w api run start:prod
```

Once the API is running, interactive API documentation is available at:

```
http://localhost:3000/api/docs
```

---

## Web Client

The `app/` directory contains a Vue 3 single-page application for interacting with the encoding API. It provides:

- **Auth0 login** — users sign in via Auth0's Universal Login; access tokens are obtained automatically for API calls
- Drag-and-drop file upload with a browse fallback
- Resumable chunked file upload via the tus protocol
- Probe result display showing detected video and audio tracks with editable metadata (names, languages)
- Configurable encoding settings (video renditions with ABR ladder suggestions, audio groups with quality tiers, copy/re-encode toggles, VBR/CBR) via the shared `EncodeConfigForm` component
- Encode config persistence — previous configs for the same media layout are saved to localStorage and can be restored
- S3 storage configuration (persisted to localStorage between sessions)
- Optional webhook and encryption configuration
- Real-time session progress via polling with status badges and a progress bar
- **HLS media preview** — on completion, a Video.js player loads the master playlist directly from S3, with an ABR quality selector for switching between renditions and thumbnail scrubbing preview
- **Copy S3 URL** — one-click copy of the S3 m3u8 URL to clipboard

**Tech stack:** Vite, Vue 3, Tailwind CSS v4, Video.js 8, tus-js-client, Auth0 Vue SDK, Vitest, TypeScript.

The web client communicates directly with the API (no proxy). CORS is configured on the API via the `CORS_ORIGIN` environment variable (defaults to `http://localhost:5173`). Authentication is handled via Auth0 — the web client requires `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, and `VITE_AUTH0_AUDIENCE` environment variables.

---

## API Documentation

Session creation, encoding, status polling, and deletion use a **Bearer JWT** (Auth0 access token). File upload uses the **tus protocol** with a separate **Bearer token** returned from session creation.

### 1. Create an Encoding Session

```
POST /api/sessions
Authorization: Bearer <auth0_access_token>
Content-Type: application/json
```

**Request Body:**

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
  "webhook": {
    "url": "https://myapp.example.com/webhooks/encode",
    "sessionToken": "my-webhook-secret-token"
  },
  "encryption": {
    "enabled": true,
    "keyUrl": "https://myapp.example.com/keys"
  },
  "segmentDuration": 6,
  "byteRange": true,
  "byteRangeMaxFileSizeMB": 500,
  "thumbnails": true
}
```

The `webhook`, `encryption`, `segmentDuration`, `byteRange`, `byteRangeMaxFileSizeMB`, and `thumbnails` fields are all optional.

- `segmentDuration` defaults to `6` seconds
- `byteRange` defaults to `true` (consolidate segments into fewer large files)
- `byteRangeMaxFileSizeMB` defaults to `500` MB
- `thumbnails` defaults to `true` for video encodes (generates WebVTT thumbnail sprites)
- `encryption` enables AES-128 HLS encryption when provided

**Response (201):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "tusEndpoint": "http://localhost:3000/api/tus",
  "uploadToken": "tok_f8e7d6c5b4a32910876543210abcdef0",
  "maxUploadSize": 10737418240
}
```

**curl example:**

```bash
TOKEN="your-auth0-access-token"

curl -X POST http://localhost:3000/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "s3": {
      "endPoint": "minio.example.com",
      "port": 9000,
      "useSSL": false,
      "bucket": "media-output",
      "accessKey": "minioadmin",
      "secretKey": "minioadmin"
    },
    "webhook": {
      "url": "https://myapp.example.com/webhooks/encode",
      "sessionToken": "my-secret"
    }
  }'
```

---

### 2. Upload the Source File (tus)

File upload uses the [tus protocol](https://tus.io) for resumable, chunked uploads. After creating a session, upload your file to the `tusEndpoint` using any tus client library.

The upload must include:

- **Authorization header**: `Bearer <uploadToken>` (the token from session creation)
- **Metadata**: `sessionId` (the session ID from step 1), `filename` (original filename)

On upload completion, the API automatically probes the file with ffprobe. The session transitions through `uploading` → `uploaded`, and probe results become available via the [poll endpoint](#3-poll-session-status).

**JavaScript (tus-js-client):**

```javascript
import * as tus from 'tus-js-client';

const upload = new tus.Upload(file, {
  endpoint: tusEndpoint,
  retryDelays: [0, 1000, 3000, 5000],
  chunkSize: 50 * 1024 * 1024,
  metadata: {
    sessionId: sessionId,
    filename: file.name,
    filetype: file.type,
  },
  headers: {
    Authorization: `Bearer ${uploadToken}`,
  },
  onProgress(bytesUploaded, bytesTotal) {
    console.log(`${Math.round((bytesUploaded / bytesTotal) * 100)}%`);
  },
  onSuccess() {
    console.log('Upload complete');
  },
});

upload.start();
```

**curl (tus creation + upload):**

```bash
# Create tus upload
curl -X POST http://localhost:3000/api/tus \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(stat -f%z video.mp4)" \
  -H 'Upload-Metadata: sessionId '$(echo -n $SESSION_ID | base64)',filename '$(echo -n video.mp4 | base64) \
  -D -

# Upload data to the returned Location URL
curl -X PATCH http://localhost:3000/api/tus/<upload-id> \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @video.mp4
```

---

### 3. Poll Session Status

Poll the current status of an encoding session. This is the primary status mechanism when webhooks are not configured. After upload completes, poll until `status` is `uploaded` to retrieve probe results.

```
GET /api/sessions/:sessionId
Authorization: Bearer <auth0_access_token>
```

**Response (200):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "encoding",
  "progress": 45.5
}
```

Possible `status` values:

| Status | Description | Extra fields |
|---|---|---|
| `created` | Session created, awaiting file upload | — |
| `uploading` | File upload in progress (tus) | — |
| `uploaded` | Upload complete, file probed | `probeResult` |
| `queued` | Encoding queued, waiting in FIFO queue | `queuePosition` |
| `encoding` | FFmpeg actively processing | `progress` (0-100) |
| `uploading_to_s3` | Encoding done, uploading output to S3 | `progress` (0-100) |
| `completed` | All files uploaded to S3 | `files`, `masterPlaylist`, `anglePlaylists`, `encoder`, `segmentFormat`, `thumbnailsVtt`, `previewBaseUrl`, `previewToken` |
| `failed` | Error occurred | `error` |

**Uploaded status response (with probe results):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "uploaded",
  "probeResult": {
    "format": {
      "duration": 120.5,
      "bitrateKbps": 5000,
      "formatName": "mov,mp4,m4a,3gp,3g2,mj2"
    },
    "videoTracks": [
      {
        "index": 0,
        "codec": "h264",
        "width": 1920,
        "height": 1080,
        "bitrateKbps": 4500,
        "frameRate": 30,
        "profile": "High"
      }
    ],
    "audioTracks": [
      {
        "index": 0,
        "codec": "aac",
        "bitrateKbps": 192,
        "channels": 2,
        "sampleRate": 48000,
        "language": "eng"
      }
    ]
  }
}
```

---

### 4. Start Encoding

After the file is uploaded and probed (session status is `uploaded`), submit an encoding configuration to start the encoding process.

```
POST /api/sessions/:sessionId/encode
Authorization: Bearer <auth0_access_token>
Content-Type: application/json
```

**Video encoding request body:**

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
    },
    {
      "width": 854,
      "height": 480,
      "videoBitrateKbps": 1000,
      "copyStream": false,
      "audioGroupId": "mid",
      "label": "480p",
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
    },
    {
      "id": "mid",
      "label": "Standard Audio",
      "audioBitrateKbps": 128,
      "channels": 2,
      "audioCodec": "aac",
      "sourceTrackIndex": 0,
      "language": "eng",
      "vbr": true
    }
  ]
}
```

**Audio-only encoding request body:**

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

**Response (202):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "queuePosition": 1
}
```

---

### 5. Delete a Session

Cancel and delete a session. Only sessions in `created`, `uploading`, or `uploaded` status can be deleted.

```
DELETE /api/sessions/:sessionId
Authorization: Bearer <auth0_access_token>
```

**Response:** `204 No Content`

---

### 6. Preview Endpoints (Encrypted HLS)

When HLS encryption is enabled, the API provides preview endpoints that rewrite key URIs in playlists for authenticated playback.

```
GET /api/sessions/:sessionId/preview/*
Authorization: Bearer <previewToken>
```

Serves rewritten HLS playlists with proxied key URIs.

```
GET /api/sessions/:sessionId/preview/key
Authorization: Bearer <previewToken>
```

Serves the HLS encryption key for preview playback. The `previewBaseUrl` and `previewToken` are returned in the completed session status response.

---

## Webhook Callbacks

Webhooks are optional. When a `webhook` configuration is provided in the session creation request, the service sends HTTP POST requests to your webhook URL throughout the encoding lifecycle. Each request includes:

- **Header**: `X-Session-Token: <your-session-token>` — verify this matches the token you provided to authenticate the callback.
- **Header**: `Content-Type: application/json`

### Webhook Payload

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "encoding",
  "progress": 45.5,
  "queuePosition": null,
  "message": "Encoding: 45.5% complete",
  "error": null,
  "files": null,
  "masterPlaylist": null
}
```

### Webhook Events

| Status | When | Key fields |
|---|---|---|
| `queued` | Encoding config submitted, waiting in queue | `queuePosition` |
| `queued` | Queue position updated (earlier job finished) | `queuePosition` |
| `encoding` | Encoding started / progress update (~every 5%) | `progress` |
| `uploading_to_s3` | Encoding complete, uploading files | — |
| `completed` | All done | `files`, `masterPlaylist`, `anglePlaylists` |
| `failed` | Error at any stage | `error` |

### Completed Webhook Example

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "completed",
  "progress": 100,
  "message": "Encoding and upload complete",
  "files": [
    "videos/my-project/master.m3u8",
    "videos/my-project/stream_1080p_1920x1080/init.mp4",
    "videos/my-project/stream_1080p_1920x1080/playlist.m3u8",
    "videos/my-project/stream_1080p_1920x1080/segment_000.m4s",
    "videos/my-project/stream_1080p_1920x1080/segment_001.m4s",
    "videos/my-project/stream_720p_1280x720/init.mp4",
    "videos/my-project/stream_720p_1280x720/playlist.m3u8",
    "videos/my-project/stream_720p_1280x720/segment_000.m4s",
    "videos/my-project/stream_HD/init.mp4",
    "videos/my-project/stream_HD/playlist.m3u8",
    "videos/my-project/stream_HD/segment_000.m4s"
  ],
  "masterPlaylist": "videos/my-project/master.m3u8",
  "encoder": "apple",
  "segmentFormat": "fmp4"
}
```

---

## Encoding Workflow

1. **Session creation** — Client sends S3 credentials, optional webhook URL, encryption config, and encoding options (segment duration, byte-range, thumbnails). Service returns a tus upload endpoint and upload token.
2. **File upload** — Client uploads the source media file via tus (resumable, chunked). On completion, the API auto-probes the file with ffprobe.
3. **Probe & configure** — Client polls for probe results (detected video/audio tracks), then submits an encoding configuration (video renditions, audio groups, copy/re-encode choices).
4. **Queue processing** — The session enters a FIFO queue. Sessions are processed one at a time in first-come-first-served order.
5. **Encoding** — FFmpeg probes per-stream start times and selects the optimal segment format: fMP4 segments (`.m4s` + `init.mp4`) when streams are aligned, or MPEG-TS segments (`.ts`) when streams have misaligned start times (the player's TS transmuxer synchronizes audio/video during playback). When byte-range mode is enabled (default), segments are consolidated into fewer large files using HLS byte-range addressing. Progress is reported via webhooks or polling.
6. **Encryption** — If encryption is enabled, HLS segments are encrypted with AES-128 via a worker thread. Preview endpoints are set up for authenticated playback.
7. **Thumbnail generation** — For video encodes (when enabled), sprite-based thumbnails with a WebVTT file are generated for timeline scrubbing.
8. **S3 upload** — All output files are uploaded to the client-specified S3 bucket (with configurable concurrency).
9. **Completion** — Final webhook includes the full list of S3 object keys, master playlist path, thumbnail VTT path, and preview URLs (if encrypted).

---

## GPU Acceleration

The service automatically detects hardware acceleration at startup, checking for NVIDIA first, then Apple Silicon, with CPU as the final fallback.

### NVIDIA (Linux / Windows)

Detected when:

1. `nvidia-smi` is available and exits cleanly
2. `ffmpeg -hwaccels` includes `cuda`

When detected, video encoding uses:

- **Decoder**: `-hwaccel cuda -hwaccel_output_format cuda`
- **Encoder**: `h264_nvenc` (instead of `libx264`)
- **Scaler**: `scale_cuda` (instead of `scale`) — keeps frames in GPU memory

### Apple Silicon (macOS M1+)

Detected when:

1. Platform is `darwin` and architecture is `arm64`
2. `ffmpeg -hwaccels` includes `videotoolbox`
3. `ffmpeg -encoders` includes `h264_videotoolbox`
4. `ffmpeg -filters` includes `scale_vt`

When detected, video encoding uses:

- **Decoder**: `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
- **Encoder**: `h264_videotoolbox` with `-profile high`, `-allow_sw 1` (graceful software fallback), `-realtime 0` (quality-optimised)
- **Scaler**: `scale_vt` (instead of `scale`) — keeps frames in VideoToolbox GPU memory

### CPU Fallback

When no GPU is detected, the service uses `libx264` with resolution-based presets.

Audio encoding always uses CPU regardless of GPU availability (no GPU benefit).

The active mode is logged at startup:

```
NVIDIA GPU detected, using NVENC acceleration
```

```
Apple Silicon detected, using VideoToolbox acceleration
```

```
No GPU found, using CPU encoding
```

---

## S3 Compatibility

The service uses the [MinIO JavaScript client](https://min.io/docs/minio/linux/developers/javascript/API.html) for S3 uploads, which is compatible with:

- **MinIO**
- **Cloudflare R2**
- **AWS S3**
- **Backblaze B2**
- **DigitalOcean Spaces**
- Any other S3-compatible storage

S3 credentials are provided per-session in the session creation request, so different sessions can upload to different buckets or storage providers.

---

## HLS Output Structure

The segment format is chosen automatically based on source stream alignment:

- **fMP4** (default when streams are aligned) — fragmented MP4 / CMAF segments (`.m4s` + `init.mp4`). Lower overhead, wider CMAF compatibility.
- **MPEG-TS** (fallback when streams have misaligned start times) — Transport Stream segments (`.ts`). The player's TS transmuxer synchronizes audio/video PTS during playback.

When byte-range mode is enabled (default), individual segments are consolidated into fewer large files using HLS `#EXT-X-BYTERANGE` addressing, significantly reducing the number of S3 objects.

The session status response includes a `segmentFormat` field (`"fmp4"` or `"mpegts"`) indicating which format was used.

**fMP4 output** (aligned streams) for a session with 2 video renditions and 2 audio groups:

```
{pathPrefix}/
├── master.m3u8                         # Master playlist referencing all variants
├── stream_1080p_1920x1080/
│   ├── init.mp4                        # fMP4 init segment
│   ├── playlist.m3u8                   # Variant playlist (1080p video)
│   ├── segment_000.m4s
│   ├── segment_001.m4s
│   └── ...
├── stream_720p_1280x720/
│   ├── init.mp4
│   ├── playlist.m3u8                   # Variant playlist (720p video)
│   ├── segment_000.m4s
│   └── ...
├── stream_HD/
│   ├── init.mp4
│   ├── playlist.m3u8                   # Audio rendition (HD Audio)
│   ├── segment_000.m4s
│   └── ...
├── stream_Standard/
│   ├── init.mp4
│   ├── playlist.m3u8                   # Audio rendition (Standard Audio)
│   ├── segment_000.m4s
│   └── ...
└── thumbnails/                         # (when thumbnails enabled)
    ├── thumbnails.vtt                  # WebVTT file for timeline scrubbing
    └── sprite_*.jpg                    # Thumbnail sprite sheets
```

**MPEG-TS output** (misaligned streams) has the same structure but with `.ts` segments and no `init.mp4`:

```
{pathPrefix}/
├── master.m3u8
├── stream_1080p_1920x1080/
│   ├── playlist.m3u8
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── ...
├── ...
```

**With byte-range mode** (default), segments are consolidated into larger media files:

```
{pathPrefix}/
├── master.m3u8
├── stream_1080p_1920x1080/
│   ├── init.mp4                        # (fMP4 only)
│   ├── playlist.m3u8                   # Contains #EXT-X-BYTERANGE entries
│   ├── media_0.m4s (or media_0.ts)    # Consolidated segment file
│   └── ...
├── ...
```

Stream directory names are derived from the rendition labels (e.g. `stream_1080p_1920x1080`, `stream_HD`).

For audio-only with multiple bitrates:

```
{pathPrefix}/
├── master.m3u8
├── stream_High_Quality/
│   ├── init.mp4
│   ├── playlist.m3u8
│   ├── segment_000.m4s
│   └── ...
└── stream_Bandwidth_Saving/
    ├── init.mp4
    ├── playlist.m3u8
    ├── segment_000.m4s
    └── ...
```

---

## Error Handling

- **Process isolation**: FFmpeg runs as a child process. Crashes, timeouts, or errors in FFmpeg never crash the NestJS service.
- **Queue resilience**: A failed encoding job is marked as `failed` with an error webhook, and the queue continues to the next job.
- **Graceful shutdown**: On `SIGTERM`/`SIGINT`, in-flight FFmpeg processes are terminated cleanly, and expired tus uploads are cleaned up before the service exits.
- **Webhook failures**: If a webhook delivery fails, it is logged but never blocks or crashes the encoding pipeline.
- **Upload resilience**: The tus protocol supports resumable uploads — if a connection drops, the client can resume from where it left off.
- **Temp file cleanup**: Working files are removed after each session completes or fails.
