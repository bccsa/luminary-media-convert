# API endpoints and environment (detail)

## API Endpoints

Auth column: **instance** = the instance `X-API-Key` token; **session** = `Bearer sess_*`; **read** = `?token=read_*`; **origin** = browser Origin allowlist; **query token** = `?token=` carrying the session token.

### Encoding sessions (`/api/sessions`)

| Method | Path                                                  | Auth                              | Description                                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/sessions`                                       | token                             | Create a session (S3 + encryption + segment/byte-range/thumbnail options). Returns `{ sessionId, sessionToken }`                                                                                                                                                      |
| GET    | `/api/sessions`                                       | token                             | List every session on this instance, newest first, including session tokens (the UI is the only holder of the instance token)                                                                                                                                         |
| POST   | `/api/sessions/:id/local-file`                        | token, session                    | Attach an absolute path to a file already on this machine. Returns once probed                                                                                                                                                                                        |
| POST   | `/api/sessions/:id/encode`                            | token, session                    | Submit the encode config and enqueue. `202`                                                                                                                                                                                                                           |
| GET    | `/api/sessions/:id`                                   | token, session, read              | Poll status: probe results, progress, `hlsUrl`, `canRetry`, `queuePosition`, trim segments, files on completion (no key — see `/key`)                                                                                                                                 |
| GET    | `/api/sessions/:id/events`                            | query token (session **or** read) | SSE event stream                                                                                                                                                                                                                                                      |
| GET    | `/api/sessions/:id/key`                               | token, session, read              | Masked AES-128 session key `{ maskedKeyHex }` (XOR `SHA-256(sessionId)[0..16]`, self-inverse). 404 when the session has no encryption                                                                                                                                 |
| DELETE | `/api/sessions/:id`                                   | token, session                    | Cancel and delete. Allowed from `created`, `uploading`, `uploaded`, `queued`, `encoding`, `failed`, `completed` — the terminal two included, which is the only way their disk is reclaimed. `encrypting` and `uploading_to_s3` are refused: the pipeline is mid-write |
| GET    | `/api/sessions/:id/chapters?lang=en`                  | token, session                    | Read `chapters/<lang>.vtt` from the session's own prefix                                                                                                                                                                                                              |
| PUT    | `/api/sessions/:id/chapters?lang=en`                  | token, session                    | Write `chapters/<lang>.vtt` (≤ 1 MiB, `text/vtt`). `204`                                                                                                                                                                                                              |
| GET    | `/api/sessions/:id/waveform`                          | query token                       | Waveform peaks for the source (`{ peaks, numPeaks }`)                                                                                                                                                                                                                 |
| GET    | `/api/sessions/:id/preview/audio-tracks`              | query token                       | Preview audio tracks                                                                                                                                                                                                                                                  |
| GET    | `/api/sessions/:id/preview/playlist.m3u8`             | query token                       | Preview master playlist (`?audio=<index>`)                                                                                                                                                                                                                            |
| GET    | `/api/sessions/:id/preview/r:rendition/playlist.m3u8` | query token                       | Preview rendition playlist                                                                                                                                                                                                                                            |
| GET    | `/api/sessions/:id/preview/r:rendition/:filename`     | query token                       | Preview MPEG-TS segment                                                                                                                                                                                                                                               |
| GET    | `/api/sessions/:id/thumbnails/thumbnails.vtt`         | query token                       | Source storyboard WebVTT (cues rewritten to absolute, token-carrying sprite URLs; `X-Storyboard-Complete`)                                                                                                                                                            |
| GET    | `/api/sessions/:id/thumbnails/:filename`              | query token                       | Source storyboard sprite sheet                                                                                                                                                                                                                                        |

### CMS handshake (`/api/cms`)

| Method | Path                | Auth   | Description                                                                     |
| ------ | ------------------- | ------ | ------------------------------------------------------------------------------- |
| GET    | `/api/cms/health`   | none   | `{ status: 'ok', apiVersion }` — is the local encoder installed and running     |
| POST   | `/api/cms/sessions` | origin | Open (or reuse) a session for a CMS document; returns `readToken` + `eventsUrl` |

### HLS edit (`/api/hls`, stateless, inline S3 credentials)

| Method | Path                      | Auth  | Description                                                                                                                 |
| ------ | ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/hls/read`           | token | Fetch and parse a master playlist; returns the parsed master + current ETag                                                 |
| POST   | `/api/hls/mutate`         | token | Apply ordered ops (upsert/remove subtitle, upsert/remove chapters) with `If-Match`; returns the new ETag. `409` on mismatch |
| POST   | `/api/hls/discover`       | token | Scan a folder prefix for HLS masters / angles                                                                               |
| POST   | `/api/hls/chapters/read`  | token | Read `chapters/<lang>.vtt` under a prefix; `404` when absent                                                                |
| POST   | `/api/hls/chapters/write` | token | Write `chapters/<lang>.vtt` under a prefix                                                                                  |
| POST   | `/api/hls/waveform/read`  | token | Read `waveform.json` under a prefix; `404` when absent                                                                      |

## Environment Variables

### API (`api/.env`, standalone only — the Electron host passes these in code)

| Variable                          | Default                       | Description                                                                                                                                  |
| --------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_API_TOKEN`                 | —                             | The instance API token accepted on `X-API-Key`. Unset disables key auth entirely. `MASTER_API_KEY` is still read, with a deprecation warning |
| `PORT`                            | `3000` (standalone `main.ts`) | HTTP port. The embedded default is `31711` (`DEFAULT_PORT`)                                                                                  |
| `HOST`                            | `127.0.0.1`                   | Bind address                                                                                                                                 |
| `WORK_DIR`                        | `./work`                      | Scratch directory for sessions, previews, sidecars                                                                                           |
| `CMS_ALLOWED_ORIGINS`             | —                             | Comma-separated origins trusted without asking (there is no approver standalone)                                                             |
| `FFMPEG_PATH` / `FFPROBE_PATH`    | PATH lookup                   | Absolute paths to the binaries                                                                                                               |
| `FFMPEG_TIMEOUT_MS`               | none                          | Max FFmpeg runtime before a forced kill                                                                                                      |
| `FFMPEG_THREADS`                  | —                             | Thread count passed to FFmpeg                                                                                                                |
| `DISK_RESERVE_BYTES`              | `2147483648`                  | Free space to keep in hand on the work volume                                                                                                |
| `SESSION_ABANDONED_MAX_AGE_HOURS` | `6`                           | How long an idle session may sit before it is swept                                                                                          |
| `SESSION_CLEANUP_CRON`            | `0 * * * *`                   | Sweep schedule                                                                                                                               |
| `S3_UPLOAD_STALL_TIMEOUT_MS`      | `300000`                      | Stall detector for S3 uploads (measured in bytes sent, not files completed)                                                                  |
