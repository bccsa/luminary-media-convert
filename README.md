# Luminary Media Convert

HLS/ABR media encoding service built with NestJS. Accepts encoding requests via REST API, processes media files with FFmpeg (GPU-accelerated when NVIDIA hardware is available), uploads HLS output to any S3-compatible storage, and delivers status updates via webhooks.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [API Documentation](#api-documentation)
  - [1. Create an Encoding Session](#1-create-an-encoding-session)
  - [2. Upload the Source File](#2-upload-the-source-file)
  - [3. Poll Session Status (optional)](#3-poll-session-status-optional)
- [Webhook Callbacks](#webhook-callbacks)
- [Encoding Workflow](#encoding-workflow)
- [GPU Acceleration](#gpu-acceleration)
- [S3 Compatibility](#s3-compatibility)
- [HLS Output Structure](#hls-output-structure)
- [Error Handling](#error-handling)

---

## Architecture Overview

```
Client                    Luminary Service                     External
──────                    ────────────────                     ────────
  │                              │                                │
  │  1. POST /api/sessions       │                                │
  │  (auth + encoding config) ──>│                                │
  │<── { sessionId,              │                                │
  │      uploadUrl,              │                                │
  │      uploadToken }           │                                │
  │                              │                                │
  │  2. POST uploadUrl           │                                │
  │  (Bearer token + file) ────>│                                │
  │<── 202 { queued }           │                                │
  │                              │                                │
  │                              │── webhook: { status: queued } ──>│ Webhook
  │                              │                                │  Endpoint
  │                              │── FFmpeg encode ──┐            │
  │                              │<── progress ──────┘            │
  │                              │── webhook: { encoding, 45% } ─>│
  │                              │                                │
  │                              │── upload to S3 ───────────────>│ S3
  │                              │── webhook: { completed,       ──>│ Storage
  │                              │    files: [...],               │
  │                              │    masterPlaylist: "..." }     │
  │                              │                                │
  │  3. GET /api/sessions/:id    │                                │
  │  (optional polling) ───────>│                                │
  │<── { status, progress, ... }│                                │
```

## Prerequisites

- **Node.js** >= 18
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

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `AUTH_USERNAME` | **Yes** | — | Basic auth username for API access |
| `AUTH_PASSWORD` | **Yes** | — | Basic auth password for API access |
| `WORK_DIR` | No | `./work` | Directory for temporary files during encoding |
| `FFMPEG_TIMEOUT_MS` | No | `0` (none) | Max time for FFmpeg process before forced kill |

Example `.env` file:

```bash
PORT=3000
AUTH_USERNAME=admin
AUTH_PASSWORD=your-secure-password
```

## Getting Started

```bash
# Install dependencies
npm install

# Development (watch mode)
npm run start:dev

# Production build
npm run build
npm run start:prod
```

Once running, interactive API documentation is available at:

```
http://localhost:3000/api/docs
```

---

## API Documentation

All endpoints under `/api/sessions` require authentication. Session creation and status polling use **Basic Auth**. File upload uses a **Bearer token** returned from session creation.

### 1. Create an Encoding Session

```
POST /api/sessions
Authorization: Basic base64(username:password)
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
curl -X POST http://localhost:3000/api/sessions \
  -u admin:your-secure-password \
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

### 3. Poll Session Status (optional)

The primary status delivery mechanism is webhooks. This endpoint is an optional convenience for polling.

```
GET /api/sessions/:sessionId
Authorization: Basic base64(username:password)
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

The service sends HTTP POST requests to your webhook URL throughout the encoding lifecycle. Each request includes:

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

1. **Session creation** — Client sends encoding configuration (renditions, S3 creds, webhook URL). Service returns upload URL + token.
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
