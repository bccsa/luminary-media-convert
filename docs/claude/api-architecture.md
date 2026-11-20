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
        "mode": "edit", // optional; "encode" (default) or "edit"
        "existingMedia": { "hlsUrl": "…", "hlsKey": "…" }, // required with mode "edit": the video to open; ignored otherwise
    }
    ```

    Response `201`:

    ```jsonc
    {
        "sessionId": "…",
        "readToken": "read_…",
        "eventsUrl": "http://127.0.0.1:31711/api/sessions/<id>/events?token=read_…",
        "apiVersion": "0.0.1",
        "reused": false,
        "hlsUrl": "…/master_r3.m3u8", // edit mode only: the revision actually opened
    }
    ```

    - **Idempotency**: a repeat click on the same `documentId` returns the session already in flight (`reused: true`) rather than starting a second one. Only _active_ sessions match — a finished one means "replace what is there".
    - **Per-session subfolder**: the destination becomes `<canonicalPrefix(pathPrefix)>/<sessionId>`, so a re-encode of the same post cannot half-overwrite the live output.
    - **Window focus**: creating (or reusing) a session fires `CMS_SESSION_HOOK`, which the Electron host uses to bring its window forward — the user has to pick a file, and the app may be behind the browser.
    - **`eventsUrl`** is built from the request's own `Host`, because the port is assigned by the host app and this process has no better idea of it than the caller does.
    - **Edit mode** (`mode: 'edit'`) opens the post's existing video instead of encoding a new one: chapters, subtitles, audio tracks (rename, remove, add from a file), camera angles (rename, remove, add) and a regenerated storyboard. It never encodes the video and never touches its segments; the session's prefix is the video's own folder. The master is read before the session exists, so a URL outside the bucket, a missing file or a wrong `hlsKey` is refused here rather than on the first save; a document whose encode is still running gets 409 and the encoder's window instead. Reuse matches on the video (folder + stem), not on the exact revision.
    - **Newest wins**: an edit session opens the **highest revision in the folder**, which can be newer than `existingMedia.hlsUrl` — an edit whose announcement the CMS missed (tab closed, encoder restarted). The response's `hlsUrl` names the revision opened; the CMS stores it at once. An edit is undone by saving over it, not by pointing the CMS at an older revision, which the next open would move forward again.

3. **SSE** — the CMS subscribes to `eventsUrl` with `EventSource`. Events are the `SessionEvent` shape:

    ```ts
    { sessionId, status, progress?, pipelineProgress?, queuePosition?, error?, files?,
      masterPlaylist?, thumbnailsVtt?, hlsUrl?, segmentFormat?, cmsPending?,
      encoder?, probeResult?, ingestTotalBytes? }
    ```

    **The first event on every connection is a snapshot** of the session as it stands (status, `hlsUrl`, `masterPlaylist`, `thumbnailsVtt`, `cmsPending`, …); live events follow. A CMS that reconnects, or comes back after the tab was closed, catches up from it.

    **`hlsUrl` arrives early and keeps changing.** It is first published when the encode is queued (`QueueService.enqueue` → `EncodeService.prepareDelivery`), not when it starts or completes — the destination key and the AES key are both settled long before the first segment exists, so a session waiting behind another encode can be saved straight away. After that it changes on **every edit** for the life of the session (a chapter save after completion, any save in an edit session, a finished add-track/add-angle/thumbnails job), because each edit is a new master revision (below); `masterPlaylist` and `thumbnailsVtt` move with it. The CMS stores each new value. The decryption key is **no longer part of any status/SSE payload**: the CMS fetches it from `GET /api/sessions/:id/key?token=read_…` → `{ maskedKeyHex }` and unmasks it (XOR with the first 16 bytes of `SHA-256(sessionId)` — self-inverse, formula published; an obscurity measure keeping raw keys out of logs/proxies, not DRM). `hlsUrl` + the unmasked key are what Luminary saves as `MediaDto { hlsUrl, hlsKey }`; a new revision in the same folder keeps the same key. `cms-mock/src/store.ts` (`announce`, `acknowledge`, `captureHlsKey`) is the reference implementation.

4. **Polling fallback** — `GET /api/sessions/:id?token=read_…` returns the same `hlsUrl` and `cmsPending`, so a CMS that reconnects mid-encode can ask again; the key comes from the key endpoint as above.
5. **Acknowledge** — `POST /api/sessions/:id/ack?token=read_…` with `{ "hlsUrl": "…" }` → `204`. Tells the encoder the document has **stored** that URL. It counts only when it equals the session's current `hlsUrl`, and is ignored (still `204`) otherwise; `401` for anything but the session's read token — the UI's session token cannot claim the CMS stored something, and a session the encoder no longer holds takes its token with it. Encoders from before this route answer `404`, so a CMS must ignore a `404`.

#### Master revisions

Nothing published is rewritten under the same name, so a CDN or browser can never serve a stale copy of a changed file, and a document still naming an older version gets a consistent older version rather than a mix.

- **The encode writes `master.m3u8` (revision 0); every edit writes `master_r1.m3u8`, `master_r2.m3u8`, …** in the same folder, so every relative URI stays valid. N is one more than the revision the edit branched from; "newest" is the highest N in the folder; there is no clock in the name. The new `hlsUrl` is the old one with its last path segment swapped. Older revisions stay playable.
- **One path for every master change**: `VideoRevisionService` (`api/src/encode/services/video-revision.service.ts`) runs the CMS gate, then the save, then announces and waits for the ack; `MasterRevisionService` (`api/src/hls-edit/master-revision.service.ts`) owns the naming, `latestRevision` and the write. An in-memory lock per video (folder + stem) queues saves within one encoder; the stale-panel check (`ifMatch` against the current revision's ETag, 409 `ETAG_MISMATCH`) is unchanged; the new revision is written with a `HEAD` check and then `putObjectIfAbsent` (`If-None-Match: *`). If another machine already wrote that N, the save answers 409 `CHANGED_ELSEWHERE` (body carries the newest `hlsUrl`), and the session moves to the newest revision and announces it; the app reloads onto it and the user re-saves. `SessionService.setMasterRevision` updates `hlsUrl`/`masterPlaylist`, persists them, and emits the event the CMS stores from. A job that adds a track or an angle writes the revision after the one it read, so nothing else may publish while it runs: saves and a storyboard rebuild are refused meanwhile, and neither job starts during a storyboard rebuild (which itself writes onto the master as it is when it finishes).
- **Versioned sidecars**: chapters are written as `chapters/<lang>_<8hex>.vtt`, a new name per save, plus a legacy `chapters/<lang>.vtt` copy (`no-cache`, marked `LEGACY-CHAPTERS`) for viewers that build that URL themselves — removed one month after the Luminary viewer ships the new player. On a published video the legacy copy is written only after the revision has landed, so a refused save leaves older viewers on the chapters they had. A regenerated storyboard is `thumbnails/thumbnails_<8hex>.vtt` with new sprites; subtitles were already versioned (`subtitles/<lang>_<hex>.m3u8`/`.vtt`), as are added track and angle folders. Everything an edit writes under a new name carries `IMMUTABLE_CACHE_CONTROL` (`public, max-age=31536000, immutable`); the encode's own uploads set no Cache-Control.
- **Chapters during an encode**: before the master exists, `PUT /chapters` records the file on the session (replacing the previous draft, which nobody can have fetched) and answers `{}`. The encode writes the index lines into revision 0 just before encrypting playlists; a save that lands after that point is published as `master_r1.m3u8` right after completion. Afterwards a chapter save is an ordinary revision.
- **Nothing replaced is deleted any more** — not replaced subtitles, sprites or chapter files, because the previous revision still names them and an out-of-date document still plays it. The only exception is the chapter draft above. They go when the CMS API deletes the video's whole folder (the post's video removed or replaced); nothing reclaims them sooner. The `.orig` copy of the first edit is gone too: revision 0 is never overwritten, and the older revisions are the history.

#### Index lines in the master

The master names its current chapter and thumbnail files in `#EXT-X-SESSION-DATA` lines, which hls-core keeps unchanged as raw layout items:

```
#EXT-X-SESSION-DATA:DATA-ID="com.luminary.chapters",LANGUAGE="en",URI="chapters/en_1a2b3c4d.vtt",FORMAT=RAW
#EXT-X-SESSION-DATA:DATA-ID="com.luminary.thumbnails",URI="thumbnails/thumbnails.vtt",FORMAT=RAW
#EXT-X-SESSION-DATA:DATA-ID="com.luminary.thumbnails.main",VIDEO="main",URI="thumbnails/thumbnails_9f8e7d6c.vtt",FORMAT=RAW
```

- URIs are relative to the master; `FORMAT=RAW` is what the HLS spec requires for a URI that is not JSON. One chapters line per language.
- `VIDEO="<GROUP-ID>"` ties a thumbnail strip to an angle (the same id as `EXT-X-STREAM-INF`'s `VIDEO` and player-core's `Angle.id`); the DATA-ID carries the group id as a suffix only because the spec forbids two tags with the same DATA-ID and LANGUAGE. No `VIDEO` means one strip for every angle. Pick order for angle A (`resolveThumbnails`): the entry with `VIDEO=A` → the entry without `VIDEO` → the first entry → the fixed-name fallback. A regenerated strip is tagged with the angle it was sampled from and replaces every thumbnails line the master had (there is one strip per video for now, and an older line left in place would keep the old strip on the other angles); removing an angle drops its line.
- The initial encode writes these lines too (chapters drafted during the encode, and `thumbnails/thumbnails.vtt` — tagged with the sampled track's angle on a multi-angle encode).
- **A master without them** (every video encoded before this) falls back to `chapters/<lang>.vtt` and `thumbnails/thumbnails.vtt`, so old videos need no migration.
- Helpers live in `hls-core/src/session-data.ts`. The API resolves chapters as index line → `session.chapterFiles` → legacy key; the player reads the lines and strips `com.luminary.*` before handing the master to an engine (`docs/claude/player.md`).

#### The CMS gate

A save only counts once the CMS has stored it, so the encoder never reports success for a version no document points at.

- **One state per session**: `hlsUrl` (the newest revision) and the acknowledged URL. The session is **pending** (`cmsPending: true`) while they differ. `CmsAckService` (`api/src/encode/services/cms-ack.service.ts`) holds it, and counts the read-token event streams open per session.
- **Before any write that creates a revision**, and at the start of every job that will (`POST /media/audio-tracks`, `POST /media/video-angles`, `POST /thumbnails/regenerate` in an edit session), both must hold, or it is refused with 409 `CMS_NOT_ACKNOWLEDGED` and nothing is written: (1) a read-token event stream for the session is open — the CMS page is following it; (2) the session is not pending. With no CMS page following, the refusal is immediate: nobody is there to send an ack. With one following, it waits up to ~10 s for the ack of a save just made, and gives up early if the page goes.
- **After a save** the new revision is announced, and the save waits up to ~10 s for its own ack. The response carries `published: true` (stored) or `false` (landed, not yet stored). Jobs are checked at start and written and announced at the end; without an ack the session is simply pending.
- **Starting state**: an edit session starts acknowledged when it opened the URL the CMS sent, and pending when "newest wins" opened a newer one, until the CMS stores the response's `hlsUrl`. An encode session is pending from the moment its URL is announced until the post is saved in the CMS — so a chapter save after completion is refused on a post that has never been saved.
- **Only CMS sessions are gated** (those with a read token); a `POST /api/sessions` session has no CMS to wait for. A chapter draft during the encode creates no revision and is never gated.
- The pending state lives in memory: after an encoder restart it is gone, and "newest wins" at the next edit open recovers a version the CMS never stored.

#### What the CMS stores, and when it acknowledges

- **Same folder as the stored URL** (a new revision of the same video): auto-save the media field alone (`media.hlsUrl`, `media.hlsKey`) at once, leaving the editor's other unsaved edits alone, then ack.
- **Another folder, or nothing stored** (the first URL of an encode, or a re-encode): write it onto the open document as before; the editor's own Save stores it; ack after that save. Auto-saving here would be wrong: the Luminary API deletes the old folder as soon as a document's URL moves to another one, so the live video would go before the new one exists.
- **Ack whenever the stored URL equals the announced one** — after an auto-save, after the editor's save, and at once when it is already stored (an edit session's first event, a reconnect). A failed save is not acked. A `404` from `ack` is ignored.
- **Keep following a session after `completed` / `failed`**: edits after completion still announce URLs. Forget it only when the encoder no longer holds it (`404`; a purged session's read token also draws `401` from the auth guard) or it names another document.

**Release order: the CMS first.** The Luminary CMS change (store every changed `hlsUrl`, ack, keep following finished sessions) deploys before the encoder release. It is safe with older encoders — they never change `hlsUrl` and answer `404` to `ack` — and the other order would leave a new encoder refusing every save to a CMS that never acks. CMS edit mode on the Luminary side (#205) builds to this contract: open with `mode: 'edit'` + `existingMedia`, take `hlsUrl` from the create response and from every event, and ack as above.

### Trust model: three token tiers plus an origin allowlist

| Tier               | Form                                                                                                  | Who holds it                    | What it can do                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance API token | `X-API-Key: <token>`                                                                                  | The app's own UI only           | Everything. Minted per launch by the Electron main process (`randomBytes(32)`), handed to the renderer over the preload bridge, never written to disk. Standalone it falls back to `LOCAL_API_TOKEN` (or the deprecated `MASTER_API_KEY`) |
| Session token      | `Authorization: Bearer sess_*` (also accepted as `?token=` on source / preview / waveform / storyboard routes) | The UI, per session             | Drive one session: attach a file, start the encode, poll, delete, read/write its chapters, edit an existing video (edit sessions), stream its preview                                                                                     |
| Read token         | `?token=read_*`                                                                                       | The CMS that opened the session | Watch, plus acknowledge: the SSE stream, the status endpoint, the key endpoint, and `POST /ack` (the document has stored a version). Cannot start, cancel, save, or reach the source file. Minted only for `origin: 'cms'` sessions       |

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
3. `IngestService.finalizeUpload` runs the shared post-ingest pipeline: record the path → ffprobe → status `uploaded` → prime the waveform cache and the source storyboard in the background.
4. The client computes a suggested encode config from the probe results (`EncodeConfigForm`); the user adjusts renditions / audio groups / copy / VBR and optionally marks trim segments.
5. `POST /api/sessions/:id/encode` validates the config (video needs ≥ 1 rendition and ≥ 1 audio group; every rendition's `audioGroupId` must exist; `copyStream` needs a `sourceTrackIndex`), refuses sessions without usable credentials, and enqueues. A `failed` session whose source file is still on disk may be retried (`canRetry` on the status response).
6. FIFO queue, one encode at a time.
7. `EncodeService` clears any previous output, generates the AES key/IV **before** flipping to `encoding`, publishes `hlsUrl` (`publicBaseUrl` + `/` + `<prefix>/master.m3u8`), and starts `SegmentPipelineService`, which polls the FFmpeg output directory and streams each new segment through encrypt → upload → byte-range pack with bounded concurrency, instead of waiting for the encode to finish.
8. Output is **always fMP4** (`.m4s` + a per-stream init; ffmpeg names it — `init.mp4`, or `init_<variant>.mp4` on FFmpeg 8 — and `#EXT-X-MAP` matches whichever it wrote). A source whose used streams start ≥ 20 ms apart is aligned with an input seek (`-ss` to the latest start; concat `inpoint` bump when trimming) — every stream loses the same head, timestamps stay honest, lip-sync is preserved (verified to sub-millisecond by content correlation). `segmentFormat` reports `'fmp4'`; `'mpegts'` survives only on sessions restored from before this change. **Copy-mode video is gated by the source** (`copy-mode-eligibility.ts`): the track must not be early-starting on a misaligned source (keyframe-granular seek ⇒ permanent desync) and its keyframe cadence must be regular and divide the segment duration, compared in frames so NTSC rates pass; and **its pixels must already be square**, because a copied stream's SAR is in its bitstream where the muxer cannot reach it. Strict on unknowns. Refused at encode submit with a message naming the track; `EncodeConfigForm` disables the Copy toggle with the same reason from probe data (`gopFrames`/`gopRegular`/`startTime`/`displayWidth` on the probe result). The square-pixel rule also takes quick trim away from an anamorphic source, which follows: a lossless cut of one is anamorphic output by definition.
9. After drain: `#EXT-X-KEY` tags injected (when encrypted), thumbnail sprites + `thumbnails.vtt` generated for video encodes, `waveform.json` written as a sidecar next to `master.m3u8`, and the master's `#EXT-X-SESSION-DATA` index lines added for the thumbnails and any chapters drafted so far (see "Index lines in the master"). On an encrypted session every `.m3u8` and `.vtt` is then LMCENC-encrypted with the same key (AES-128-CBC, fresh IV per file, `LMCENC01` magic — see `docs/encrypted-sidecar-format.md`) as the **final** pre-upload step; encrypted objects upload as `application/octet-stream`. `encryption.encryptPlaylists: false` opts out, for output that must stay readable by players that cannot decrypt playlists.
10. Completion sets `files`, `masterPlaylist`, `thumbnailsVtt` and `segmentFormat`, and emits the final event. The key is never in the payload — clients use `GET /api/sessions/:id/key`. A chapter save that landed after the index lines were written is published straight after as `master_r1.m3u8`, with a new `hlsUrl`.

Disk is guarded on both ends: `disk-space.ts` refuses an ingest or an encode that will not fit, keeping a reserve (`DISK_RESERVE_BYTES`, default 2 GB), so a full volume cannot take the next encode down with it.

### Encoding features

- **Video + audio-only modes**: `EncodeConfigDto.type` is `'video'` or `'audio'`
- **Trim segments**: optional `trimSegments` restricts the encode to one or more `[in, out]` ranges, concatenated in order. The preview stays the whole source; the player skips the cuts as it plays, before the encode and during it, so cut points can be checked before queueing
- **Byte-range HLS**: on by default; segments packed into **shared chunk chains** under `media/` at the prefix root — one chain per video angle carrying every rendition of that angle (interleaved by arrival; byte order inside a chunk is irrelevant to a whole-object backhaul, so no cross-stream barrier exists), one audio chain carrying every audio group. Media playlists stay per-stream and reference chunks as `../media/<chain>_<n>.m4s` with `#EXT-X-BYTERANGE` (ciphertext offsets). The first chunk of a chain closes at ~20 s of content so a byte-range-forwarding edge warms almost immediately at play-start; later chunks are cap-sized (`byteRangeMaxFileSizeMB` default 500 for video chains, `audioByteRangeMaxFileSizeMB` default 50 for the audio chain — it aggregates every language, wide ladders should raise it). Chain identity comes from `FfmpegService.buildStreamChainMap`, never from parsing directory names. Packing happens in `SegmentPipelineService` as segments arrive; the fMP4 init is deliberately **not** uploaded mid-encode (FFmpeg creates it empty and fills it later — an early upload raced that write and shipped zero-byte inits), it travels with the remaining files at the end
- **Copy mode** (`-c:v copy` / `-c:a copy`) and **VBR** (CRF/CQ) per rendition and per audio group
- **Audio groups** mapped to renditions via HLS `#EXT-X-MEDIA` `GROUP-ID`; multi-track audio with language/name attributes; mono/stereo/5.1/7.1 via `-ac`
- **Multi-angle video**: multiple source video tracks become `TYPE=VIDEO` rendition groups in the single master (see the player contract above)
- **HLS encryption**: AES-128 via worker threads; key and `hlsUrl` published when the session is queued (the key is kept across retries)
- **Thumbnails**: sprite sheets + WebVTT for the encoded output, plus a separate pre-encode _source storyboard_ served from `/api/sessions/:id/thumbnails/*` so the trim timeline can show frames before anything is encoded (`X-Storyboard-Complete` tells the client when sampling has finished)
- **Waveform**: peaks computed once per source, cached on disk, served over HTTP for the trim UI and written to S3 as `waveform.json`

### Preview: the source file, or a conversion of it

The pre-encode preview plays the **source file itself** whenever the browser can decode it, and a converted HLS stream only when it cannot.

- **Direct play**: `GET /api/sessions/:id/source?token=` serves the file as it is on disk (`res.sendFile`, which answers `Range`/`If-Range`/`HEAD` with 206 and 416; `dotfiles: 'allow'`, since the source lives wherever the user keeps it; `Cross-Origin-Resource-Policy: cross-origin`, since a `<video src>` request is no-cors). No FFmpeg is involved: seeks land at once whatever the encoder is doing to the GPU. **The renderer decides** which sources play directly (`app/src/utils/previewPlayback.ts`: the probe checked against a per-container allowlist of codecs and pixel formats; `canPlayType` is asked only about HEVC, and a file with several audio tracks also needs `audioTracks` on the media element) — the API never does. The player reports a file it could not play — a `MediaError` other than a network one, a video source whose picture the browser dropped, or a file whose metadata has not arrived after 20 s — and the renderer falls back to the converted preview for as long as the session view is open. A network error on the file is left to the player's own retry panel and does not convert it
- **Converted preview** (`PreviewService`), for everything else: a single rendition of the video stream the storyboard also samples (`selectStoryboardTrack`), built lazily on the first preview request — never at ingest, since most sources never ask for it
  - H.264 8-bit 4:2:0, not anamorphic: **copied** at native size; audio to AAC
  - anything else: **transcoded** to at most 720p
  - audio-only: AAC, on the CPU
  - segments of ~4 s in MPEG-TS, written to `<segment>.part` and renamed into place, cached under `<workDir>/<sessionId>/preview/v2/` (the folder is versioned; an older build's cache beside it is removed), prefetched, at most 3 concurrent FFmpeg processes. Multi-audio: one track chosen by `?audio=`, each `(rendition, audioTrack)` pair cached separately
- **Where a copied rendition is cut** (`layoutCopy`). A copied segment can only start on a keyframe, and the playlist lists every segment up front, so the boundaries have to be known first:
  - a stream whose probe shows a **fixed keyframe interval** (`gopRegular`, seen at least twice in the 200-frame head sample) has them **computed** — each segment a whole number of intervals reaching 4 s, counted in frames from the first keyframe. No scan, so the preview opens at once
  - any other stream is **scanned** (`scanKeyframeGrid`, which reads the whole file), and the player waits for that. A scan that fails or times out makes the preview a transcoded one rather than a copy cut off its keyframes
  - the head sample is not the file, so every copied segment of a computed layout is **checked for landing on its boundary**. A miss means the source does not keep the interval: the segment is refused, the file is scanned and the playlists are laid out again, numbered from 1 000 000 on so nothing from the old playlist can be mistaken for the new. The app reloads a converted preview when it fails, at most once a minute, and that load waits for the rebuilt playlists
  - **seeks are counted from the start of the file.** FFmpeg adds the container's start time to `-ss`, and a transport stream never starts at zero; boundaries are on the source's own clock (`-copyts`), so the container start (`format=start_time`) is taken off every seek on the copy path. Without that a `.ts` source's segments start a keyframe or more late
  - copied segments are the source's own bitrate, so only a **rolling window** is kept: the newest 16, within 500 MB (the newest 4 always, whatever their size). Transcoded segments are all kept
- **One encoder session is kept free for a transcoded preview.** The preview used to stall when an encode started, because its segments queued behind ladder waves holding every session. `ladderSessionCap` (`encoder-sessions.ts`) makes the ladder plan its waves around one session fewer when a transcoded preview is in use — the encoding session's own, or another session's built or asked for a segment in the last 10 minutes. The cap is decided when a session's first encode starts and kept on the session (`encoderSessionCap`), because a continued encode has to plan the waves the run before it planned. Copied and audio-only previews open no encoder and reserve nothing
- No trims on the server: the preview is always the whole source
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
