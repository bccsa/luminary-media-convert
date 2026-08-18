# cms-mock

A dev-only Vue 3 app that stands in for the Luminary CMS, so the whole
CMS → encoding-API flow can be exercised locally without the real CMS.

It is **not** shipped: nothing in `api/` or `app/` depends on it.

## Why it exists

The CMS integration is small but easy to get subtly wrong — origin gating, the
`documentId` reuse rule, the exact moment `hlsUrl` becomes available, and the
`luminary://key` placeholder the player swaps at playback time. This mock drives
each of those against the real local API.

It runs on port **5199** on purpose: its origin (`http://localhost:5199`) differs
from the API's, so every request goes through the real CORS / origin-gating path
instead of taking a same-origin shortcut.

## Run it

```bash
npm -w cms-mock run dev     # http://localhost:5199
```

The encoding API must be running locally (default `http://127.0.0.1:31711`; the
base URL is editable in the UI). When the API is unreachable the connection
panel offers an `luminary-convert://` launch link plus a retry button — the same
behaviour the real CMS has when the desktop app is not running.

## What it does

1. **Connection** — `GET /api/cms/health`, showing status and `apiVersion`.
2. **Create session** — `POST /api/cms/sessions` with the form's `documentId`,
   `title`, S3 config, `publicBaseUrl` and encoding options. The raw response is
   shown, with a `reused` badge when the API hands back an existing session for
   the same `documentId`.
3. **SSE console** — subscribes to the returned `eventsUrl` with `EventSource`
   and logs every event as pretty JSON. The first event carrying `hlsUrl` is
   highlighted and pinned into a "What Luminary would save" card in `MediaDto`
   shape (`{ hlsUrl, hlsKey }`) — that is the moment the real CMS writes to its
   document.
4. **Playback check** — fetches the reported `hlsUrl`. While it 404s it shows
   "not available yet" (what the real player does mid-encode). Once it resolves,
   it lists the video angles and renders the extracted single-angle and
   audio-only playlists via `@luminary-media-converter/hls-core`
   (`listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`),
   then locates the `#EXT-X-KEY` line and previews the `luminary://key`
   substitution the real player performs with the reported `hlsKey`.

Actual video playback stays in the main app — this mock proves URL availability,
angle extraction and the key swap, not decoding.

Form values (including the API base URL) persist to `localStorage`, so a page
reload does not mean retyping S3 credentials.

## MinIO assumption

Defaults are prefilled for a local MinIO: endpoint `127.0.0.1`, port `9000`,
`useSSL` off, bucket `media`, credentials `minioadmin` / `minioadmin`, and
`publicBaseUrl` `http://127.0.0.1:9000/media`.

That last one assumes the `media` bucket allows anonymous reads — otherwise the
playback check cannot fetch the master playlist from the browser. Point the
fields at any S3-compatible store if you are not using MinIO.
