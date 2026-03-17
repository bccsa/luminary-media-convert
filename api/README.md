# Luminary Encoding API

Open-source, stateless HLS/ABR encoding service built with NestJS. Accepts encoding requests via REST API, processes media files with FFmpeg (GPU-accelerated when NVIDIA or Apple Silicon hardware is available), uploads HLS output to any S3-compatible storage, and delivers status updates via webhooks or polling.

The Encoding API is designed to run standalone on GPU-equipped hardware. It has no dependency on any external user management layer.

## Table of Contents

- [Authentication](#authentication)
- [Environment Variables](#environment-variables)
- [API Documentation](#api-documentation)
  - [1. Create an Encoding Session](#1-create-an-encoding-session)
  - [2. Upload the Source File (tus)](#2-upload-the-source-file-tus)
  - [3. Poll Session Status](#3-poll-session-status)
  - [4. Start Encoding](#4-start-encoding)
  - [5. Delete a Session](#5-delete-a-session)
  - [6. Preview Endpoints (Encrypted HLS)](#6-preview-endpoints-encrypted-hls)
- [Webhook Callbacks](#webhook-callbacks)
- [Authorization Webhook](#authorization-webhook)
- [Encoding Workflow](#encoding-workflow)
- [GPU Acceleration](#gpu-acceleration)
- [S3 Compatibility](#s3-compatibility)
- [HLS Output Structure](#hls-output-structure)
- [Error Handling](#error-handling)

---

## Authentication

The Encoding API uses key-based authentication with no external identity provider dependency. All credentials are passed via the `X-API-Key` header or `Authorization: Bearer` header.

### Master API Key

The master key is configured via the `MASTER_API_KEY` environment variable. It is accepted on **all** endpoints. This is the only credential needed for standalone or development use.

```
X-API-Key: <master_api_key>
```

In a multi-tenant deployment, the master key is used by the management layer (e.g., a SaaS service) to create sessions on behalf of users. End users never see the master key.

### API Keys

API keys provide scoped access to session operations (create, upload, encode, poll, preview, delete). The Encoding API does not store or manage API keys -- it validates them via an external **key validation webhook** (`KEY_VALIDATION_WEBHOOK_URL`).

When an API key is presented, the Encoding API sends it to the configured webhook URL. The external service validates the key and returns metadata (userId, webhookUrl, authorizationUrl). Validation results are cached briefly (default 60s, configurable via `KEY_VALIDATION_CACHE_TTL_MS`).

```
X-API-Key: lmc_...
```

If `KEY_VALIDATION_WEBHOOK_URL` is not configured, the Encoding API operates in **standalone mode** -- only the master key is accepted and API key authentication is not available.

### Session Tokens

When a session is created, a session token (`sess_*` prefix) is returned. This scoped token grants access to a single session for upload (tus), polling, encode submission, and preview playback. It cannot create new sessions.

```
Authorization: Bearer sess_...
```

### Authentication Summary

| Credential | Header | Scope | Provisioning |
|------------|--------|-------|-------------|
| Master key | `X-API-Key` | All endpoints (superkey) | `MASTER_API_KEY` env var |
| API key | `X-API-Key` | Session operations only | Validated via `KEY_VALIDATION_WEBHOOK_URL` (externally managed) |
| Session token | `Authorization: Bearer sess_*` | Single session only | Returned by `POST /api/sessions` |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MASTER_API_KEY` | **Yes** | -- | Master API key accepted on all endpoints (superkey). Set to any secret string. |
| `PORT` | No | `3000` | HTTP server port |
| `WORK_DIR` | No | `./work` | Directory for temporary files during encoding |
| `FFMPEG_TIMEOUT_MS` | No | `0` (none) | Max time for FFmpeg process before forced kill |
| `FFMPEG_THREADS` | No | `8` | Number of threads for FFmpeg encoding |
| `MAX_UPLOAD_SIZE` | No | `10737418240` (10 GB) | Maximum upload file size in bytes |
| `CORS_ORIGIN` | No | `*` (all origins) | Allowed CORS origin. Set to a specific origin to restrict access. |
| `KEY_VALIDATION_WEBHOOK_URL` | No | -- | URL the Encoding API calls to validate API keys. When not configured, only the master key works (standalone mode). |
| `KEY_VALIDATION_WEBHOOK_TIMEOUT_MS` | No | `5000` | Key validation webhook response timeout |
| `KEY_VALIDATION_CACHE_TTL_MS` | No | `60000` | How long to cache key validation results (default 60s) |
| `AUTHORIZATION_WEBHOOK_URL` | No | -- | Global authorization webhook URL (per-key config from validation response takes precedence) |
| `AUTHORIZATION_WEBHOOK_TIMEOUT_MS` | No | `5000` | Authorization webhook response timeout |
| `AUTHORIZATION_WEBHOOK_FAIL_MODE` | No | `open` | Behavior when authorization webhook is unreachable: `open` or `closed` |
| `TUSD_BINARY_PATH` | No | -- | Override path to the tusd Go binary |

Example `api/.env`:

```bash
MASTER_API_KEY=my-secret-master-key
PORT=3000
```

---

## API Documentation

Interactive Swagger/OpenAPI documentation is available at `/api/docs` when the server is running.

### Endpoints Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sessions` | Master key or API key | Create encoding session |
| ALL | `/api/tus`, `/api/tus/*` | Session token | Tus upload endpoint |
| GET | `/api/sessions/:sessionId` | Master key, API key, or session token | Poll session status |
| POST | `/api/sessions/:sessionId/encode` | Master key, API key, or session token | Submit encoding config |
| DELETE | `/api/sessions/:sessionId` | Master key or API key | Cancel and delete session |
| GET | `/api/sessions/:sessionId/preview/*` | Session token | Rewritten HLS playlist for preview |
| GET | `/api/sessions/:sessionId/preview/key` | Session token | HLS encryption key for preview |

### 1. Create an Encoding Session

```
POST /api/sessions
X-API-Key: <master_key_or_api_key>
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
- When using an API key whose validated metadata includes a `webhookUrl`, that URL is used automatically if no per-session webhook is configured

**Response (201):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "tusEndpoint": "http://localhost:3000/api/tus",
  "sessionToken": "sess_f8e7d6c5b4a3291087654321",
  "maxUploadSize": 10737418240
}
```

**curl example:**

```bash
API_KEY="your-master-or-api-key"

curl -X POST http://localhost:3000/api/sessions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "s3": {
      "endPoint": "minio.example.com",
      "port": 9000,
      "useSSL": false,
      "bucket": "media-output",
      "accessKey": "minioadmin",
      "secretKey": "minioadmin"
    }
  }'
```

---

### 2. Upload the Source File (tus)

File upload uses the [tus protocol](https://tus.io) for resumable, chunked uploads. After creating a session, upload your file to the `tusEndpoint` using any tus client library.

The upload must include:

- **Authorization header**: `Bearer <sessionToken>` (the session token from session creation)
- **Metadata**: `sessionId` (the session ID from step 1), `filename` (original filename)

The tus protocol supports **parallel uploads** — the client splits the file into chunks and uploads multiple chunks concurrently, significantly improving upload speed on high-bandwidth connections. The recommended configuration is 50 MB chunks with up to 5 parallel uploads. The tus protocol also supports automatic **resume** — if a connection drops mid-upload, the client can resume from the last successfully uploaded byte without re-uploading the entire file.

On upload completion, the API automatically probes the file with ffprobe. The session transitions through `uploading` -> `uploaded`, and probe results become available via the poll endpoint.

Incomplete uploads expire after 10 minutes and are cleaned up automatically on server shutdown.

**JavaScript (tus-js-client):**

```javascript
import * as tus from 'tus-js-client';

const upload = new tus.Upload(file, {
  endpoint: tusEndpoint,
  retryDelays: [0, 1000, 3000, 5000],
  parallelUploads: 5,
  chunkSize: 50 * 1024 * 1024,
  metadata: {
    sessionId: sessionId,
    filename: file.name,
    filetype: file.type,
  },
  headers: {
    Authorization: `Bearer ${sessionToken}`,
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
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(stat -f%z video.mp4)" \
  -H 'Upload-Metadata: sessionId '$(echo -n $SESSION_ID | base64)',filename '$(echo -n video.mp4 | base64) \
  -D -

# Upload data to the returned Location URL
curl -X PATCH http://localhost:3000/api/tus/<upload-id> \
  -H "Authorization: Bearer $SESSION_TOKEN" \
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
X-API-Key: <master_key_or_api_key>
# or: Authorization: Bearer <session_token>
```

Or:

```
GET /api/sessions/:sessionId
X-API-Key: lmc_...
```

**Response (200):**

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "encoding",
  "progress": 45.5
}
```

**Status values:**

| Status | Description | Extra fields |
|---|---|---|
| `created` | Session created, awaiting file upload | -- |
| `uploading` | File upload in progress (tus) | -- |
| `uploaded` | Upload complete, file probed | `probeResult` |
| `queued` | Encoding queued, waiting in FIFO queue | `queuePosition` |
| `encoding` | FFmpeg actively processing | `progress` (0-100) |
| `encrypting` | HLS encryption in progress | `progress` (0-100) |
| `uploading_to_s3` | Encoding done, uploading output to S3 | `progress` (0-100) |
| `completed` | All files uploaded to S3 | `files`, `masterPlaylist`, `anglePlaylists`, `encoder`, `segmentFormat`, `thumbnailsVtt`, `previewBaseUrl`, `sessionToken` |
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
X-API-Key: <master_key_or_api_key>
# or: Authorization: Bearer <session_token>
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

Cancel and delete a session. Allowed in `created`, `uploading`, `uploaded`, `queued`, or `encoding` status. Queued sessions are removed from the queue. Encoding sessions have their FFmpeg process terminated.

```
DELETE /api/sessions/:sessionId
X-API-Key: <master_key_or_api_key>
```

**Response:** `204 No Content`

---

### 6. Preview Endpoints (Encrypted HLS)

When HLS encryption is enabled, the API provides preview endpoints that rewrite key URIs in playlists for authenticated playback. The `previewBaseUrl` and `sessionToken` are returned in the completed session status response.

```
GET /api/sessions/:sessionId/preview/*
Authorization: Bearer <sessionToken>
```

Serves rewritten HLS playlists with proxied key URIs.

```
GET /api/sessions/:sessionId/preview/key
Authorization: Bearer <sessionToken>
```

Serves the HLS encryption key for preview playback.

---

## Webhook Callbacks

Webhooks are optional. When a `webhook` configuration is provided in the session creation request (or returned by the key validation webhook as part of the API key's metadata), the service sends HTTP POST requests to the webhook URL throughout the encoding lifecycle. Each request includes:

- **Header**: `X-Session-Token: <your-session-token>` -- verify this matches the token you provided to authenticate the callback.
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
| `encrypting` | HLS encryption in progress | `progress` |
| `uploading_to_s3` | Encoding complete, uploading files | `progress` |
| `completed` | All done | `files`, `masterPlaylist`, `anglePlaylists`, `encoder`, `segmentFormat`, `thumbnailsVtt` |
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
    "videos/my-project/stream_1080p_1920x1080/segment_000.m4s"
  ],
  "masterPlaylist": "videos/my-project/master.m3u8",
  "encoder": "apple",
  "segmentFormat": "fmp4"
}
```

---

## Authorization Webhook

The Encoding API supports an optional authorization webhook -- an HTTP callback invoked before processing privileged operations. This allows an external system to enforce authorization decisions without the Encoding API needing any awareness of users, plans, or billing.

### Configuration

The authorization webhook URL is configured:

1. **Per API key** -- `authorizationUrl` returned by the key validation webhook (takes precedence)
2. **Globally** -- `AUTHORIZATION_WEBHOOK_URL` environment variable

When no authorization URL is configured, all requests are allowed.

### Trigger Points

| Operation | Endpoint | Payload includes |
|-----------|----------|-----------------|
| Session creation | `POST /api/sessions` | API key metadata, S3 config summary |
| Encode start | `POST /api/sessions/:id/encode` | API key metadata, encode config, cost estimate |

### Authorization Request

The Encoding API sends a POST to the configured URL:

```json
{
  "action": "create_session",
  "userId": "<user-id-from-key-validation>",
  "apiKeyMetadata": { "planTier": "payg" },
  "sessionId": "<session-id>",
  "encodeConfig": null,
  "costEstimate": null,
  "timestamp": "2026-03-16T10:00:00Z"
}
```

### Authorization Response

```json
{ "allowed": true }
```

Or:

```json
{
  "allowed": false,
  "reason": "Monthly encoding limit reached"
}
```

### Failure Behavior

- `allowed: true` (or HTTP 200 with no body) -- operation proceeds
- `allowed: false` -- request rejected with `403 Forbidden` including the `reason`
- Webhook unreachable or 5xx -- configurable via `AUTHORIZATION_WEBHOOK_FAIL_MODE`:
  - `open` (default) -- allow the request, log a warning
  - `closed` -- reject the request

---

## Encoding Workflow

1. **Session creation** -- Client sends S3 credentials, optional webhook URL, encryption config, and encoding options (segment duration, byte-range, thumbnails). Service returns a tus upload endpoint and session token.
2. **File upload** -- Client uploads the source media file via tus (resumable, chunked). On completion, the API auto-probes the file with ffprobe.
3. **Probe and configure** -- Client polls for probe results (detected video/audio tracks), then submits an encoding configuration (video renditions, audio groups, copy/re-encode choices).
4. **Queue processing** -- The session enters a FIFO queue. Sessions are processed one at a time in first-come-first-served order.
5. **Encoding** -- FFmpeg probes per-stream start times and selects the optimal segment format: fMP4 segments (`.m4s` + `init.mp4`) when streams are aligned, or MPEG-TS segments (`.ts`) when streams have misaligned start times. When byte-range mode is enabled (default), segments are consolidated into fewer large files using HLS byte-range addressing. Progress is reported via webhooks or polling.
6. **Encryption** -- If encryption is enabled, HLS segments are encrypted with AES-128 via a worker thread. Preview endpoints are set up for authenticated playback.
7. **Thumbnail generation** -- For video encodes (when enabled), sprite-based thumbnails with a WebVTT file are generated for timeline scrubbing.
8. **S3 upload** -- All output files are uploaded to the client-specified S3 bucket.
9. **Completion** -- Final webhook includes the full list of S3 object keys, master playlist path, thumbnail VTT path, and preview URLs (if encrypted).

### Session Lifecycle

```
created -> uploading -> uploaded -> queued -> encoding -> encrypting -> uploading_to_s3 -> completed
                                                       \-> failed
```

---

## GPU Acceleration

The service automatically detects hardware acceleration at startup, checking for NVIDIA first, then Apple Silicon, with CPU as the final fallback.

### NVIDIA (Linux / Windows)

Detected when `nvidia-smi` is available and `ffmpeg -hwaccels` includes `cuda`.

- **Decoder**: `-hwaccel cuda -hwaccel_output_format cuda`
- **Encoder**: `h264_nvenc`
- **Scaler**: `scale_cuda` (keeps frames in GPU memory)

### Apple Silicon (macOS M1+)

Detected when platform is `darwin`, architecture is `arm64`, and FFmpeg supports `videotoolbox`, `h264_videotoolbox`, and `scale_vt`.

- **Decoder**: `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
- **Encoder**: `h264_videotoolbox`
- **Scaler**: `scale_vt` (keeps frames in VideoToolbox GPU memory)

### CPU Fallback

When no GPU is detected, the service uses `libx264` with resolution-based presets. Audio encoding always uses CPU.

The active mode is logged at startup and reported in session status responses via the `encoder` field.

---

## S3 Compatibility

The service uses the MinIO JavaScript client for S3 uploads, compatible with:

- MinIO
- Cloudflare R2
- AWS S3
- Backblaze B2
- DigitalOcean Spaces
- Any other S3-compatible storage

S3 credentials are provided per-session, so different sessions can upload to different buckets or storage providers.

---

## HLS Output Structure

The segment format is chosen automatically based on source stream alignment:

- **fMP4** (default when streams are aligned) -- fragmented MP4 / CMAF segments (`.m4s` + `init.mp4`). Lower overhead, wider CMAF compatibility.
- **MPEG-TS** (fallback when streams have misaligned start times) -- Transport Stream segments (`.ts`). The player's TS transmuxer synchronizes audio/video PTS during playback.

When byte-range mode is enabled (default), individual segments are consolidated into fewer large files using HLS `#EXT-X-BYTERANGE` addressing, significantly reducing the number of S3 objects.

The session status response includes a `segmentFormat` field (`"fmp4"` or `"mpegts"`) indicating which format was used.

**fMP4 output** (aligned streams) for a session with 2 video renditions and 2 audio groups:

```
{pathPrefix}/
+-- master.m3u8
+-- stream_1080p_1920x1080/
|   +-- init.mp4
|   +-- playlist.m3u8
|   +-- segment_000.m4s
|   +-- segment_001.m4s
+-- stream_720p_1280x720/
|   +-- init.mp4
|   +-- playlist.m3u8
|   +-- segment_000.m4s
+-- stream_HD/
|   +-- init.mp4
|   +-- playlist.m3u8
|   +-- segment_000.m4s
+-- stream_Standard/
|   +-- init.mp4
|   +-- playlist.m3u8
|   +-- segment_000.m4s
+-- thumbnails/
    +-- thumbnails.vtt
    +-- sprite_*.jpg
```

Stream directory names are derived from the rendition labels (e.g. `stream_1080p_1920x1080`, `stream_HD`).

---

## Error Handling

- **Process isolation**: FFmpeg runs as a child process. Crashes, timeouts, or errors in FFmpeg never crash the NestJS service.
- **Queue resilience**: A failed encoding job is marked as `failed` with an error webhook, and the queue continues to the next job.
- **Graceful shutdown**: On `SIGTERM`/`SIGINT`, in-flight FFmpeg processes are terminated cleanly, and expired tus uploads are cleaned up before the service exits.
- **Webhook failures**: If a webhook delivery fails, it is logged but never blocks or crashes the encoding pipeline.
- **Upload resilience**: The tus protocol supports resumable uploads -- if a connection drops, the client can resume from where it left off.
- **Temp file cleanup**: Working files are removed after each session completes or fails.

---

## Development

```bash
# Development mode with watch
npm -w api run start:dev

# Production build
npm -w api run build
npm -w api run start:prod

# Unit tests
npm -w api test

# End-to-end tests
npm -w api run test:e2e
```

## Tech Stack

- Node.js with TypeScript (ES2023, nodenext modules)
- NestJS 11 (Express platform)
- Key-based authentication (master key + webhook-validated API keys + session tokens)
- FFmpeg via child_process (GPU-accelerated when available)
- MinIO JS client for S3 uploads
- class-validator + class-transformer for DTO validation
- Swagger/OpenAPI at `/api/docs`
- Vitest for testing
