# Luminary Media Convert

HLS/ABR media encoding service built with NestJS. Accepts encoding requests via REST API, processes media files with FFmpeg (GPU-accelerated when NVIDIA hardware is available), uploads HLS output to any S3-compatible storage, and delivers status updates via webhooks or polling.

The repository is an npm workspaces monorepo containing:

- **`api/`** — NestJS encoding service (REST API, FFmpeg, S3 upload, webhooks)
- **`app/`** — Vue 3 web client for uploading and monitoring encoding sessions

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Auth0 Setup](#auth0-setup)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Web Client](#web-client)
- [API Documentation](#api-documentation)
  - [1. Create an Encoding Session](#1-create-an-encoding-session)
  - [2. Upload the Source File](#2-upload-the-source-file)
  - [3. Poll Session Status](#3-poll-session-status)
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
  │      uploadUrl,                   │                           │
  │      uploadToken }                │                           │
  │                                   │                           │
  │  2. POST uploadUrl               │                           │
  │  (Bearer uploadToken + file) ──>│                           │
  │<── 202 { queued }               │                           │
  │                                   │                           │
  │                                   │── webhook: { queued } ──>│ Webhook
  │                                   │── FFmpeg encode ──┐      │ Endpoint
  │                                   │<── progress ──────┘      │
  │                                   │── webhook: { 45% } ────>│
  │                                   │                           │
  │                                   │── upload to S3 ────────>│ S3
  │                                   │── webhook: { completed } >│ Storage
  │                                   │                           │
  │  3. GET /api/sessions/:id         │                           │
  │  (Bearer JWT, polling) ─────────>│                           │
  │<── { status, progress, ... }     │                           │
```

## Prerequisites

- **Node.js** >= 18
- **Auth0 account** with an API and a Single Page Application configured (see [Auth0 Setup](#auth0-setup))
- **FFmpeg** with the following encoders/filters:
  - CPU: `libx264`, `aac`, `libmp3lame`
  - GPU (optional): `h264_nvenc`, `scale_cuda` (requires NVIDIA GPU + CUDA drivers)

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

This runs the NestJS API on `http://localhost:3000` and the Vue web client on `http://localhost:5173`.

To start workspaces individually:

```bash
# API only (watch mode)
npm -w api run start:dev

# Web client only
npm -w app run dev

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
- Configurable encoding settings (video/audio type, renditions, segment duration)
- S3 storage configuration (persisted to localStorage between sessions)
- Optional webhook configuration
- Real-time session progress via polling with status badges and a progress bar
- **HLS media preview** — on completion, a Video.js player loads the master playlist directly from S3 (assumes public bucket access), with an ABR quality selector for switching between renditions
- **Copy playlist URL** — one-click copy of the public m3u8 URL to clipboard

**Tech stack:** Vite, Vue 3, Tailwind CSS v4, Video.js 8, Auth0 Vue SDK, TypeScript.

The web client communicates directly with the API (no proxy). CORS is configured on the API via the `CORS_ORIGIN` environment variable (defaults to `http://localhost:5173`). Authentication is handled via Auth0 — the web client requires `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, and `VITE_AUTH0_AUDIENCE` environment variables.

---

## API Documentation

All endpoints under `/api/sessions` require authentication. Session creation and status polling use a **Bearer JWT** (Auth0 access token). File upload uses a separate **Bearer token** returned from session creation.

### 1. Create an Encoding Session

```
POST /api/sessions
Authorization: Bearer <auth0_access_token>
Content-Type: application/json
```

**Request Body:**

```json
{
  "type": "video",
  "renditions": [
    {
      "width": 1920,
      "height": 1080,
      "videoBitrateKbps": 5000,
      "audioBitrateKbps": 192,
      "audioCodec": "aac"
    },
    {
      "width": 1280,
      "height": 720,
      "videoBitrateKbps": 2500,
      "audioBitrateKbps": 128,
      "audioCodec": "aac"
    },
    {
      "width": 854,
      "height": 480,
      "videoBitrateKbps": 1000,
      "audioBitrateKbps": 96,
      "audioCodec": "aac"
    }
  ],
  "segmentDuration": 6,
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
  }
}
```

The `webhook` field is optional. When omitted, no webhook callbacks are sent — use the [polling endpoint](#3-poll-session-status) to track progress instead.

**Response (201):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "uploadUrl": "http://localhost:3000/api/sessions/a1b2c3d4-e5f6-7890-abcd-ef1234567890/upload",
  "uploadToken": "tok_f8e7d6c5b4a32910876543210abcdef0"
}
```

**curl example:**

```bash
# Obtain an Auth0 access token first (e.g. via client credentials or test token from Auth0 dashboard)
TOKEN="your-auth0-access-token"

curl -X POST http://localhost:3000/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "video",
    "renditions": [
      { "width": 1280, "height": 720, "videoBitrateKbps": 2500, "audioBitrateKbps": 128 },
      { "width": 854, "height": 480, "videoBitrateKbps": 1000, "audioBitrateKbps": 96 }
    ],
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

### Audio-Only Encoding

For audio-only HLS encoding, set `type` to `"audio"` and omit video fields from renditions:

```json
{
  "type": "audio",
  "renditions": [
    { "audioBitrateKbps": 192, "audioCodec": "aac" },
    { "audioBitrateKbps": 96, "audioCodec": "aac" }
  ],
  "s3": { "..." : "..." },
  "webhook": { "..." : "..." }
}
```

---

### 2. Upload the Source File

```
POST /api/sessions/:sessionId/upload
Authorization: Bearer <uploadToken>
Content-Type: multipart/form-data
```

Upload the media file as a multipart form field named `file`.

**Response (202):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "queuePosition": 1
}
```

**curl example:**

```bash
curl -X POST http://localhost:3000/api/sessions/SESSION_ID/upload \
  -H "Authorization: Bearer tok_f8e7d6c5b4a32910876543210abcdef0" \
  -F "file=@/path/to/video.mp4"
```

---

### 3. Poll Session Status

Poll the current status of an encoding session. This is the primary status mechanism when webhooks are not configured.

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
| `queued` | File received, waiting in FIFO queue | `queuePosition` |
| `encoding` | FFmpeg actively processing | `progress` (0-100) |
| `uploading_to_s3` | Encoding done, uploading to S3 | — |
| `completed` | All files uploaded to S3 | `files`, `masterPlaylist` |
| `failed` | Error occurred | `error` |

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
| `queued` | File uploaded, waiting in queue | `queuePosition` |
| `queued` | Queue position updated (earlier job finished) | `queuePosition` |
| `encoding` | Encoding started / progress update (~every 5%) | `progress` |
| `uploading_to_s3` | Encoding complete, uploading files | — |
| `completed` | All done | `files`, `masterPlaylist` |
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
    "videos/my-project/v0/playlist.m3u8",
    "videos/my-project/v0/segment_000.ts",
    "videos/my-project/v0/segment_001.ts",
    "videos/my-project/v1/playlist.m3u8",
    "videos/my-project/v1/segment_000.ts",
    "videos/my-project/v1/segment_001.ts"
  ],
  "masterPlaylist": "videos/my-project/master.m3u8"
}
```

---

## Encoding Workflow

1. **Session creation** — Client sends encoding configuration (renditions, S3 creds, optional webhook URL). Service returns upload URL + token.
2. **File upload** — Client uploads the source media file using the token. File is saved and session enters the FIFO queue.
3. **Queue processing** — Sessions are processed one at a time in first-come-first-served order. Only one FFmpeg process runs at a time.
4. **Encoding** — FFmpeg produces HLS segments and playlists for each rendition, plus a master playlist. Progress is reported via webhooks.
5. **S3 upload** — All output files (`.ts` segments + `.m3u8` playlists) are uploaded to the client-specified S3 bucket.
6. **Completion** — Final webhook includes the full list of S3 object keys and the master playlist path.

---

## GPU Acceleration

The service automatically detects NVIDIA GPU availability at startup by checking:

1. `nvidia-smi` is available and exits cleanly
2. `ffmpeg -hwaccels` includes `cuda`

When a GPU is detected, video encoding uses:

- **Decoder**: `-hwaccel cuda -hwaccel_output_format cuda`
- **Encoder**: `h264_nvenc` (instead of `libx264`)
- **Scaler**: `scale_cuda` (instead of `scale`) — keeps frames in GPU memory

When no GPU is detected, the service falls back to CPU encoding with `libx264 -preset veryfast`.

Audio encoding always uses CPU regardless (no GPU benefit).

The active mode is logged at startup:

```
NVIDIA GPU detected, using NVENC acceleration
```

or

```
No NVIDIA GPU found, using CPU encoding
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

S3 credentials are provided per-session in the encoding request, so different sessions can upload to different buckets or storage providers.

---

## HLS Output Structure

For a video encoding session with 3 renditions, the output uploaded to S3 looks like:

```
{pathPrefix}/
├── master.m3u8          # Master playlist referencing all variants
├── v0/
│   ├── playlist.m3u8    # Variant playlist (e.g. 1080p)
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── ...
├── v1/
│   ├── playlist.m3u8    # Variant playlist (e.g. 720p)
│   ├── segment_000.ts
│   └── ...
└── v2/
    ├── playlist.m3u8    # Variant playlist (e.g. 480p)
    ├── segment_000.ts
    └── ...
```

For audio-only with multiple bitrates:

```
{pathPrefix}/
├── master.m3u8
├── a0/
│   ├── playlist.m3u8    # High quality audio
│   ├── segment_000.ts
│   └── ...
└── a1/
    ├── playlist.m3u8    # Lower quality audio
    ├── segment_000.ts
    └── ...
```

---

## Error Handling

- **Process isolation**: FFmpeg runs as a child process. Crashes, timeouts, or errors in FFmpeg never crash the NestJS service.
- **Queue resilience**: A failed encoding job is marked as `failed` with an error webhook, and the queue continues to the next job.
- **Graceful shutdown**: On `SIGTERM`/`SIGINT`, in-flight FFmpeg processes are terminated cleanly before the service exits.
- **Webhook failures**: If a webhook delivery fails, it is logged but never blocks or crashes the encoding pipeline.
- **Temp file cleanup**: Working files are removed after each session completes or fails.
