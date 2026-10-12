# `api/` file layout (detail)

## Project Structure (`api/`)

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
```
