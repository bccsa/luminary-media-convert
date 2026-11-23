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
   the same `documentId`. **Edit mode** sends `mode: 'edit'` with
   `existingMedia` ("Use stored media" fills it from what the document holds);
   the response's `hlsUrl` — newer than the one sent when the folder has a later
   revision — is stored straight away.
3. **SSE console** — subscribes to the returned `eventsUrl` with `EventSource`
   and logs every event as pretty JSON. `hlsUrl` changes on every edit (a new
   `master_rN.m3u8`), so every event whose `hlsUrl` differs from the stored one
   is stored, highlighted, and shown in a "What Luminary has stored" card in
   `MediaDto` shape (`{ hlsUrl, hlsKey }`). The badge says what the real CMS
   would do: auto-save a revision in the same folder, or leave a new folder to
   the editor's Save (the mock has no Save, so it stores both). After storing,
   or on seeing a URL it already holds, it acknowledges it
   (`POST /api/sessions/:id/ack`, a 404 ignored). The **Acknowledge** switch
   turns that off, to see the encoder's pending state and refusals; turning it
   back on acks the stored URL. **Disconnect** stands in for closing the CMS tab.
   The followed session is remembered across reloads, and followed after it
   completes; it is forgotten only when the encoder no longer holds it
   (401/404) or it names another document.
4. **Playback check** — fetches the stored `hlsUrl`. While it 404s it shows
   "not available yet" (what the real player does mid-encode). Once it resolves,
   it lists the video angles and renders the extracted single-angle and
   audio-only playlists via `@luminary-media-converter/hls-core`
   (`listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`),
   then locates the `#EXT-X-KEY` line and previews the `luminary://key`
   substitution the real player performs with the reported `hlsKey`.

Actual video playback stays in the main app — this mock proves URL availability,
angle extraction and the key swap, not decoding.

Form values (including the API base URL), each document's stored media and the
followed session persist to `localStorage`, so a page reload does not mean
retyping S3 credentials or losing the session.

## MinIO assumption

Defaults are prefilled for a local MinIO: endpoint `127.0.0.1`, port `9000`,
`useSSL` off, bucket `media`, credentials `minioadmin` / `minioadmin`, and
`publicBaseUrl` `http://127.0.0.1:9000/media`.

That last one assumes the `media` bucket allows anonymous reads — otherwise the
playback check cannot fetch the master playlist from the browser. Point the
fields at any S3-compatible store if you are not using MinIO.
