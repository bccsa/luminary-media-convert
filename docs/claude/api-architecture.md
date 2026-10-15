# API architecture (detail)

Split out of the root CLAUDE.md. Read when working on `api/` sessions, the CMS contract, auth, the encoding pipeline or persistence.

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
        "documentId": "post_01HTZ8Y0J4", // idempotency key
        "title": "Episode 12", // shown in the local app
        "s3": {
            /* endPoint, port?, useSSL?, bucket, region?, accessKey, secretKey, pathPrefix? */
        },
        "publicBaseUrl": "https://cdn.example.com/media",
        "encryption": { "required": true }, // optional; a CMS states a requirement, not a key policy
        "segmentDuration": 6, // optional
        "byteRange": true, // optional
        "byteRangeMaxFileSizeMB": 500, // optional
        "audioByteRangeMaxFileSizeMB": 50, // optional; caps the shared audio chunk chain
        "thumbnails": true, // optional
        "existingMedia": { "hlsUrl": "…", "hlsKey": "…" }, // validated + accepted, NOT acted on yet
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

    - **Idempotency**: a repeat click on the same `documentId` returns the session already in flight (`reused: true`) rather than starting a second one. Only _active_ sessions match — a finished one means "replace what is there".
    - **Per-session subfolder**: the destination becomes `<canonicalPrefix(pathPrefix)>/<sessionId>`, so a re-encode of the same post cannot half-overwrite the live output.
    - **Window focus**: creating (or reusing) a session fires `CMS_SESSION_HOOK`, which the Electron host uses to bring its window forward — the user has to pick a file, and the app may be behind the browser.
    - **`eventsUrl`** is built from the request's own `Host`, because the port is assigned by the host app and this process has no better idea of it than the caller does.

3. **SSE** — the CMS subscribes to `eventsUrl` with `EventSource`. Events are the `SessionEvent` shape:
    ```ts
    { sessionId, status, progress?, pipelineProgress?, queuePosition?, error?, files?,
      masterPlaylist?, thumbnailsVtt?, hlsUrl?, segmentFormat?,
      encoder?, probeResult?, ingestTotalBytes? }
    ```
    **The event that matters** is the first one carrying `hlsUrl`: it is published when the encode is queued (`QueueService.enqueue` → `EncodeService.prepareDelivery`), not when it starts or completes — the destination key and the AES key are both settled long before the first segment exists, so a session waiting behind another encode can be saved straight away. The decryption key is **no longer part of any status/SSE payload**: the CMS fetches it from `GET /api/sessions/:id/key?token=read_…` → `{ maskedKeyHex }` and unmasks it (XOR with the first 16 bytes of `SHA-256(sessionId)` — self-inverse, formula published; an obscurity measure keeping raw keys out of logs/proxies, not DRM). `hlsUrl` + the unmasked key are what Luminary saves as `MediaDto { hlsUrl, hlsKey }`. `cms-mock/src/store.ts` (`captureHlsKey`) is the reference implementation.
4. **Polling fallback** — `GET /api/sessions/:id?token=read_…` returns the same `hlsUrl`, so a CMS that reconnects mid-encode can ask again; the key comes from the key endpoint as above.

### Trust model: three token tiers plus an origin allowlist

| Tier               | Form                                                                                                  | Who holds it                    | What it can do                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance API token | `X-API-Key: <token>`                                                                                  | The app's own UI only           | Everything. Minted per launch by the Electron main process (`randomBytes(32)`), handed to the renderer over the preload bridge, never written to disk. Standalone it falls back to `LOCAL_API_TOKEN` (or the deprecated `MASTER_API_KEY`) |
| Session token      | `Authorization: Bearer sess_*` (also accepted as `?token=` on preview / waveform / storyboard routes) | The UI, per session             | Drive one session: attach a file, start the encode, poll, delete, read/write its chapters, stream its preview                                                                                                                             |
| Read token         | `?token=read_*`                                                                                       | The CMS that opened the session | Watch only: the SSE stream and the status endpoint. Cannot start, cancel, or reach the source file. Minted only for `origin: 'cms'` sessions                                                                                              |

`AuthResolverGuard` tries them in that order. A present-but-wrong `X-API-Key` is rejected immediately rather than falling through. The instance token is a superkey: it is accepted regardless of `@AuthTypes(...)`.

`/api/cms/*` sits outside that chain — it is gated by `Origin`. A request with no `Origin` (curl, or a renderer whose origin browsers report inconsistently) is accepted only from a loopback peer, so an origin-less request off the network cannot walk past the allowlist by omitting the header.

### Local Network Access, PNA and trust on first use

A public web app reaching `127.0.0.1` is a private-network request. Chrome sends `Access-Control-Request-Private-Network: true` on the preflight and drops the real request unless the response grants it — `privateNetworkAccessMiddleware` sets `Access-Control-Allow-Private-Network: true` on those preflights, and is registered _before_ the CORS middleware, which is what ends the preflight response. That is only a grant of reachability; _who_ may talk to the API is still the origin allowlist's decision, applied by the CORS layer on the same response.

`OriginRegistry` holds the allowlist:

- Origins are normalised (lower-cased, no trailing slash) and compared exactly.
- Known origin → synchronous yes. Unknown origin with no approver → no (a headless run cannot be talked into trusting anything it was not configured with).
- Unknown origin with an approver → the Electron host shows a native "Allow this site to use the encoder?" dialog. One approval is in flight per origin, and the host serialises dialogs through a queue, so two tabs — or a page that opens an event stream and posts a session in the same tick — cannot stack two modal sheets over one decision. A dialog that fails to open is not consent.
- Decisions persist to `userData/settings.json` as `allowedOrigins` / `deniedOrigins`. Denials are remembered too, so a site that keeps retrying cannot turn "no" into a dialog every few seconds.
- After binding, the server approves its own address (`http://<host>:<port>`, plus `127.0.0.1` and `localhost` forms), so the app never asks the user whether to trust itself.
- Standalone, the allowlist comes from `CMS_ALLOWED_ORIGINS` (comma-separated) and there is no approver.

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
8. Output is **always fMP4** (`.m4s` + a per-stream init; ffmpeg names it — `init.mp4`, or `init_<variant>.mp4` on FFmpeg 8 — and `#EXT-X-MAP` matches whichever it wrote). A source whose used streams start ≥ 20 ms apart is aligned with an input seek (`-ss` to the latest start; concat `inpoint` bump when trimming) — every stream loses the same head, timestamps stay honest, lip-sync is preserved (verified to sub-millisecond by content correlation). `segmentFormat` reports `'fmp4'`; `'mpegts'` survives only on sessions restored from before this change. **Copy-mode video is gated by the source** (`copy-mode-eligibility.ts`): the track must not be early-starting on a misaligned source (keyframe-granular seek ⇒ permanent desync) and its keyframe cadence must be regular and divide the segment duration, compared in frames so NTSC rates pass; and **its pixels must already be square**, because a copied stream's SAR is in its bitstream where the muxer cannot reach it. Strict on unknowns. Refused at encode submit with a message naming the track; `EncodeConfigForm` disables the Copy toggle with the same reason from probe data (`gopFrames`/`gopRegular`/`startTime`/`displayWidth` on the probe result). The square-pixel rule also takes quick trim away from an anamorphic source, which follows: a lossless cut of one is anamorphic output by definition.
9. After drain: `#EXT-X-KEY` tags injected (when encrypted), thumbnail sprites + `thumbnails.vtt` generated for video encodes, `waveform.json` written as a sidecar next to `master.m3u8`. On an encrypted session every `.m3u8` and `.vtt` is then LMCENC-encrypted with the same key (AES-128-CBC, fresh IV per file, `LMCENC01` magic — see `docs/encrypted-sidecar-format.md`) as the **final** pre-upload step; encrypted objects upload as `application/octet-stream`. `encryption.encryptPlaylists: false` opts out, for output that must stay readable by players that cannot decrypt playlists.
10. Completion sets `files`, `masterPlaylist`, `thumbnailsVtt` and `segmentFormat`, and emits the final event. The key is never in the payload — clients use `GET /api/sessions/:id/key`.

Disk is guarded on both ends: `disk-space.ts` refuses an ingest or an encode that will not fit, keeping a reserve (`DISK_RESERVE_BYTES`, default 2 GB), so a full volume cannot take the next encode down with it.

### Encoding features

- **Video + audio-only modes**: `EncodeConfigDto.type` is `'video'` or `'audio'`
- **Trim segments**: optional `trimSegments` restricts the encode to one or more `[in, out]` ranges, concatenated in order. The preview reflects the trimmed timeline so cut points can be checked before queueing
- **Byte-range HLS**: on by default; segments packed into **shared chunk chains** under `media/` at the prefix root — one chain per video angle carrying every rendition of that angle (interleaved by arrival; byte order inside a chunk is irrelevant to a whole-object backhaul, so no cross-stream barrier exists), one audio chain carrying every audio group. Media playlists stay per-stream and reference chunks as `../media/<chain>_<n>.m4s` with `#EXT-X-BYTERANGE` (ciphertext offsets). The first chunk of a chain closes at ~20 s of content so a byte-range-forwarding edge warms almost immediately at play-start; later chunks are cap-sized (`byteRangeMaxFileSizeMB` default 500 for video chains, `audioByteRangeMaxFileSizeMB` default 50 for the audio chain — it aggregates every language, wide ladders should raise it). Chain identity comes from `FfmpegService.buildStreamChainMap`, never from parsing directory names. Packing happens in `SegmentPipelineService` as segments arrive; the fMP4 init is deliberately **not** uploaded mid-encode (FFmpeg creates it empty and fills it later — an early upload raced that write and shipped zero-byte inits), it travels with the remaining files at the end
- **Copy mode** (`-c:v copy` / `-c:a copy`) and **VBR** (CRF/CQ) per rendition and per audio group
- **Audio groups** mapped to renditions via HLS `#EXT-X-MEDIA` `GROUP-ID`; multi-track audio with language/name attributes; mono/stereo/5.1/7.1 via `-ac`
- **Multi-angle video**: multiple source video tracks become `TYPE=VIDEO` rendition groups in the single master (see the player contract above)
- **HLS encryption**: AES-128 via worker threads; key and `hlsUrl` published when the session is queued (the key is kept across retries)
- **Thumbnails**: sprite sheets + WebVTT for the encoded output, plus a separate pre-encode _source storyboard_ served from `/api/sessions/:id/thumbnails/*` so the trim timeline can show frames before anything is encoded (`X-Storyboard-Complete` tells the client when sampling has finished)
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
- `SessionCleanupService` sweeps hourly (`SESSION_CLEANUP_CRON`) and removes only _idle_ sessions — `created`, `uploading`, `uploaded` — idle longer than `SESSION_ABANDONED_MAX_AGE_HOURS` (default 6). Queued and encoding sessions are never swept
- Finished sessions are not swept on a clock; they are discarded at boot, so no age threshold has to stand in for "the user is done looking at this"
- Deleting a session removes its work directory whole (session record, preview cache, sidecars, credentials sidecar). `encrypting` and `uploading_to_s3` are the statuses that cannot be deleted — the pipeline is mid-write, and pulling its files out from under it leaves half an output in the bucket

## Session Lifecycle

```
created -> uploading -> uploaded -> queued -> encoding -> encrypting -> uploading_to_s3 -> completed
                                                       \-> failed
```

`failed` is reachable from any point. A `failed` session whose source file is still on disk and whose credentials are still usable reports `canRetry: true` and can be encoded again without re-ingesting.
