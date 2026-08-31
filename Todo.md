# Todo — follow-up work

Deferred work and known gaps after the local-only Electron migration. Each item states what exists today, what is missing, and where the work lands. Nothing here is a bug report against shipped behaviour; these are things deliberately left for later.

Ordered roughly by value, not by effort.

---

## 0. Handover state (read this first)

**Branch.** All migration work (issue #154) is on `154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features`, open as PR #161. The original seven logical commits (SaaS removal → hls lib → api → app → cms-mock → electron → docs) have since been joined by the manual-verification fixes, the app icon, a merge of `main`, and the restored test suites.

**Build state.** All workspaces build, and all test suites pass: api 815, app 215, encode-config 34, segment-editor 217, hls 121, player-core 168, player-web 79. `vue-tsc` typechecks the specs again. A packaged macOS `.app` and `.dmg` were built and verified to boot the embedded API, serve the UI, and carry the app icon.

**Player extraction (issue #153, PR #162) has since landed on top of this branch.** Playback logic left the app for two packages — `player-core` (headless: munging, controller, recovery, polling) and `player-web` (hls.js reference implementation) — Video.js is gone, and encryption now covers playlists, chapters and subtitles rather than segments alone. Items below are marked where that work closed or changed them.

**Manual verification — mostly done.** A full pass was run through the Electron app and `cms-mock` against a local MinIO: CMS handshake and idempotency, TOFU origin gating, local-file ingest by reference, probe, trim, encode, SSE with `hlsUrl` + `encryptionKeyHex`, encrypted playback via the `luminary://key` swap, chapters, session delete, and credential recovery across a restart. Several defects were found and fixed in the process (storyboard cue clipping at a trim in-point, trim semantics, timeline duration during an encode, playhead clipping at the ends, waveform contrast on an audio source, storyboard polling on a source with no video track).

- [x] **Storyboard poll died on the first request after an upload, so the trim timeline needed a manual reload.** A regression of the last fix above: `404` became the client's signal for "no frames will ever exist", but the endpoint also answered `404` for "sampling started and has written no sprite yet" — which is the state of nearly every first poll, since sampling begins on that very request. One stopped poll presented as four unrelated faults: no filmstrip, no "Generating thumbnails…" badge (`pending` is `active && !complete`), the waveform drawn in its no-filmstrip colour, and no dark bottom fade — the last two because both belong to a filmstrip that was never there. The transient case now answers `200` with an empty body and `X-Storyboard-Complete: false`, which is what the polling contract already expected; the two permanent cases still `404` before any sampling is attempted, so an audio-only source still stops asking at once. Covered by a regression test that fails without the fix. Fixed alongside it: the waveform retry chain abandoned itself when `canEditTrimTimeline` was false as the timer fired, neither fetching nor rescheduling, which left the peaks flat until a reload — the same "not yet" read as "never".

Still outstanding:

- [x] Multi-angle source: single `master.m3u8` with `#EXT-X-MEDIA:TYPE=VIDEO` groups in S3; angle switching + audio-only in the app player (client-side extraction). **Verified** against S3 output with #162 — angle, audio-track and quality selection all confirmed working.
- [x] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the _default angle_ of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls-core/` helpers depend on this. **Now has a second half:** with #162 an encrypted session also encrypts its playlists (LMCENC), which no stock player can read at all — such a client needs `encryption.encryptPlaylists: false` until it moves to `player-core`. Worth testing both, since the answer decides whether that opt-out is a transitional courtesy or a permanent mode. **Answered — §0a**, across ffmpeg, hls.js and Safari's native HLS. Both halves came back worse than the item assumed: the opt-out is not sufficient on its own, and a stock player does not stay on one angle.

### 0a. Stock-player check — results

Five outputs were encoded into a local MinIO and opened by three independent stock clients — no custom loader, no munging, no key injection, i.e. what a Luminary client that has not adopted `player-core` sees:

- **ffmpeg's HLS demuxer** (CLI)
- **hls.js 1.6.17 at default config**, Chrome 150
- **Safari 26.5.2's native HLS** — a plain `<video src>`, which is the only path an iOS web client has, since iOS does not give JavaScript players MediaSource for HLS

The harness is [`docs/stock-player-check/`](docs/stock-player-check/README.md); raw verdicts in `results-2026-08-11.md` beside it, and `results-2026-08-13.md` for the re-run against the shared-chunk-chain layout.

| # | Output | ffmpeg | hls.js (Chrome) | Safari native | Prefix in `media/` |
|---|---|---|---|---|---|
| 1 | Plaintext, 2 quality rungs, one angle | **plays** (300/300 frames over 10 s) | **plays** — 2 levels, picked level 1 | **plays** | `measure27b` |
| 2 | Plaintext, 2 angles, both 1280×720 | **plays**, fetching both angles | **plays** — *also 2 levels*, picked level 1 | **plays** | `sp-multiangle` |
| 3 | Encrypted, playlists encrypted (the default) | **fails at the master** — not a playlist | **fails** — `manifestParsingError`, "no EXTM3U delimiter" on a 200 | **fails silently** — no error event within 15 s | `772e6978-…` |
| 4 | Encrypted, `encryptPlaylists: false`, no `keyUrl` | **fails at key load** — "Unable to open key file luminary://key" | **fails** — `keyLoadError`, retried 9× then fatal | **fails** — `MEDIA_ERR_DECODE`, "Media failed to decode" | `sp-enc-sentinel` |
| 5 | Encrypted, `encryptPlaylists: false` + a fetchable `keyUrl` | **plays** | **plays** — but re-requests the key per fragment | **plays** | `sp-enc-keyurl` |

All three clients agree on which rows play and which do not, which is the useful part: these are properties of the output, not quirks of one player. **They disagree on how the failures present, and that matters to whoever has to debug one:**

- **Case 3 in Safari fails with no error at all** — the element neither played nor raised an `error` event inside 15 s, where hls.js reported a fatal `manifestParsingError` immediately. A client that shows a spinner until `error` fires would spin indefinitely. (Not observed past 15 s; the claim is only that nothing surfaced in that window.) Anything relying on an error event to detect "this player cannot read our playlists" will not get one on iOS.
- **Case 4 in Safari reports `MEDIA_ERR_DECODE`, "Media failed to decode"** — which points at the video, when the actual cause is a key URI the player cannot resolve. hls.js named it correctly (`keyLoadError` on `luminary://key`). Expect this misconfiguration to be reported as corrupt output.

**The opt-out alone is not enough, and that answers the question the item posed.** `encryptPlaylists: false` gets a stock client as far as parsing the playlist and no further: `#EXT-X-KEY` still names `luminary://key`, a scheme no player can resolve (case 4). Playing encrypted output on a stock client needs *both* the opt-out *and* an `encryption.keyUrl` serving the raw 16 key bytes over HTTP — and this encoder has no key server and should not grow one: the key is generated locally precisely so that it never leaves the machine. Case 5 only passes because a key file was placed in the bucket by hand, which publishes the key next to the content it protects and is therefore a test fixture, not a pattern to offer anyone.

So the honest guidance for a Luminary client that has not adopted `player-core`: **use unencrypted output.** The opt-out is for a client that has its own key delivery, not a way to make encrypted output generally playable. It is a permanent mode in the sense that it will keep working, but not a migration path on its own.

Case 5 is not clean even where it passes: hls.js emitted a transient `keyLoadError` ("after key load, decryptdata unset or changed") and re-requested the key repeatedly rather than once. A real `keyUrl` therefore has to be a stable, cacheable, CORS-enabled endpoint that tolerates being hit per fragment — more of a commitment than the field's one line suggests.

**Multi-angle is worse than "plays the default angle" — the flagged risk is real, and cases 1 and 2 prove it side by side.** Compare what the two clients reported: case 1 is a genuine ABR ladder (720p + 480p, one angle) and case 2 is two camera angles both at 1280×720. **Both present as "2 levels", and hls.js picked level 1 in both.** It cannot tell them apart, because nothing in a spec-correct master distinguishes them: `DEFAULT=YES` on a `TYPE=VIDEO` group does not constrain variant selection — it is advice about a rendition group most players ignore entirely — so all that is left is `BANDWIDTH`, and hls.js orders levels by bitrate. ffmpeg made the same reading, fetching segments from both angle playlists.

Which angle a stock client shows is therefore **whichever bitrate its ABR lands on**, and it is free to move between them as the network changes. On localhost hls.js took the top level, which here happens to be Wide (453 kbps) — the `DEFAULT=YES` angle — but only because the close crop encoded smaller (150 kbps). A tighter shot with more motion would have been the larger file, and the same player would have opened on Close by default. The apparent "it picks the default angle" is a coincidence of bitrate, not a rule to rely on.

So `extractAnglePlaylist` is not a nicety for these clients: **a Luminary client that will not adopt the `hls-core/` helpers should be sent single-angle output.**

Two things observed and dismissed:

- Cases 1 and 2 emit `Invalid NAL unit size` / `missing picture in access unit` under ffmpeg when opened **through the master**, never through the media playlist directly, and decode 300/300 frames over 10 s regardless. That is ffmpeg probing a byte-range fMP4 fragment without first reading its `#EXT-X-MAP` init segment — an artefact of the probe, not a defect in the output. Absent on case 5 because an encrypted fragment cannot be probed that way at all.
- Chrome's native `<video src>` path fails all five with `MEDIA_ERR_SRC_NOT_SUPPORTED`. That is Chrome having no built-in HLS, not a finding about the output.

**Re-run 2026-08-13, against the shared-chunk-chain layout** (section 11: `media/<chain>_<n>.m4s` chunks referenced as `../media/…`, always fMP4): all five verdicts identical — hls.js at default config plays cases 1, 2 and 5, byte ranges into the shared chunks included, and fails 3 and 4 exactly where designed. The layout change is invisible to stock clients. The known ffmpeg-CLI probe artefact reappeared on case 2 and was isolated further this time: it needs two same-codec video variants demuxed concurrently by ffmpeg itself, reproduces over `file://` with fully disjoint URL sets, and no real player drains variants that way — the bytes decode clean in isolation and by range-reconstruction. Raw verdicts in `results-2026-08-13.md`. Safari-native was not re-run (headless pass, Chromium only); the 8-11 Safari findings stand, and a hand re-check is one `serve.py` away.

**Settled by the Safari run:** the byte-range fMP4 output is playable by Apple's own stack (cases 1, 2 and 5 all played), so nothing about the segment format or the byte-range packing needs revisiting for iOS web. Case 5 was the genuine unknown — Safari is stricter than hls.js about both fMP4 and key delivery — and it played, which means the "readable playlists + real `keyUrl`" configuration does work everywhere. It is still not one to recommend, for the key-delivery reasons above, but it is not a web-only trick.

**Still untested, and out of scope here:** the native players a Capacitor shell would use — AVPlayer and ExoPlayer — which the Capacitor adapters will have to answer, not this item. Safari's native HLS is AVFoundation underneath, so case 5 playing is weak evidence in AVPlayer's favour; ExoPlayer has been given none. Video.js, named in the original item, was not tested separately: on desktop it wraps hls.js, so it inherits that column.

**Outstanding: the browser half.** ffmpeg settles the structure but is not hls.js and is not Safari. A harness is committed for that — [`docs/stock-player-check/`](docs/stock-player-check/README.md), which loads hls.js with **default config** (no custom loader, no munging, no key injection) and offers a native-`<video>` button per case for Safari's built-in HLS. Its README has the two commands. Expected per the table above; the interesting rows are 2 (does hls.js's ABR actually cross angles?) and 4 (does it report a key error or a manifest error?). Note the whole exercise settles the *web* only — AVPlayer and ExoPlayer remain untested, which matters when the Capacitor adapters land.
- [ ] Queue: three CMS sessions encoding FIFO with SSE `queuePosition` updates.
- [ ] Protocol handler from a packaged install: `open luminary-convert://` launches/focuses the app.
- [ ] Packaged mac build encodes with `encoder: 'apple'` (VideoToolbox). **No longer blocked on bundling the binaries, and no longer falling back to PATH.** A `pack` build was launched and probed while closing the packaging fix: it boots, serves the client from its own resources, reports "Apple Silicon detected, using VideoToolbox acceleration", and shuts down cleanly on `SIGTERM` (queue teardown ran, port released, no orphan ffmpeg). The package carries arm64 `ffmpeg`/`ffprobe` whose only hwaccel is `videotoolbox`, and `bundledBinary()` prefers `process.resourcesPath` whenever `app.isPackaged`, so a machine with no system ffmpeg is covered. What is still unproven is an **encode** through the packaged app — the instance token is minted per launch and handed only to the renderer, so driving one from outside needs the UI. Caveat for a clean clone: `pack` does not run `fetch-binaries` (only `dist:mac` / `dist:win` do), so a `--dir` build on a machine that has never fetched them ships without ffmpeg.

---

## 0b. CMS-side integration (bccsa/luminary — out of this repo)

The encoder's half of the contract is done and documented (CLAUDE.md "CMS contract"; `cms-mock/` is the executable reference). The Luminary side still needs, on branch `1878-api-cms-hls-media-data-model` or successor:

- The "upload / edit media" button: health-check `GET /api/cms/health` on `http://127.0.0.1:31711`, `luminary-convert://` launch fallback, then `POST /api/cms/sessions` (Chrome LNA; Chrome-only at time of writing).
- SSE consumer on `eventsUrl`: on the first `encoding` event, save `MediaDto { hlsUrl, hlsKey }` — the post can be saved before encoding completes. **Changed by #162:** the key no longer rides on the event. Fetch it from `GET /api/sessions/:id/key?token=read_…` and unmask it (XOR with `SHA-256(sessionId)[0..16]`, self-inverse); `cms-mock/src/store.ts` (`captureHlsKey`) is the reference. A CMS still reading `encryptionKeyHex` off the frame will silently get `undefined`.
- Player-side: **adopt `@luminary-media-converter/player-web`** (or `player-core` with an adapter) rather than wiring the `hls-core/` helpers by hand — it already does angle extraction, the `luminary://key` swap from memory, quality capping, chapters, subtitles, recovery, and the "not available yet" state as a `coming-soon` slot that polls until the playlist appears. Since #162 an encrypted session also encrypts its playlists and VTTs, which only these packages can read.
- Passing `existingMedia { hlsUrl, hlsKey }` for edit mode once item 1 lands (the DTO already accepts it).

**If any Luminary surface will play this output with something other than `player-core`** — plain hls.js, Video.js, an iOS `<video>` — then two rules are not optional, per the measurements in §0a:

1. **Send it unencrypted.** `encryption.encryptPlaylists: false` alone is not enough: the playlist parses and then `#EXT-X-KEY` still names `luminary://key`, which no player can resolve. Making it work needs a `keyUrl` serving the raw key over HTTP, which this encoder deliberately is not.
2. **Send it single-angle.** A stock player cannot tell a camera angle from a bitrate rung — both are just `#EXT-X-STREAM-INF` variants — so it opens on whichever bitrate its ABR picks and may cross between angles mid-playback. Either encode one angle, or narrow the master client-side with `extractAnglePlaylist`.

**Failure signatures, for whoever fields the bug report.** Both of the above fail in ways that point away from the cause:

| Symptom | Actual cause |
|---|---|
| iOS/Safari: spinner that never resolves, **no `error` event at all** | Encrypted playlists (LMCENC) reaching a player that cannot decrypt them. Nothing to catch — do not build a spinner that waits for `error` |
| Safari: `MEDIA_ERR_DECODE`, "Media failed to decode" | Not the video. An `#EXT-X-KEY` URI the player cannot resolve — usually `luminary://key` |
| hls.js: `keyLoadError` retried 9× then fatal | Same cause, named correctly. Presents as a long hang before the failure |
| hls.js: `manifestParsingError`, "no EXTM3U delimiter" on an HTTP 200 | Same as the first row. The 200 is real; the body is ciphertext |
| The wrong camera angle, or the angle changing by itself | Rule 2 above |

**One assumption to confirm rather than inherit:** `encryptPlaylists` defaults to `true`, which is right if every consumer is `player-core`. If any surface might not be, that default silently produces output which fails invisibly on iPhone. The default probably should not change — encrypting segments while publishing the layout and chapter titles beside them protects little — but the roadmap answer should come from Luminary, not from this repo.

---

## 1. Edit mode for existing HLS collections

**Today.** `CmsCreateSessionDto.existingMedia` (`{ hlsUrl, hlsKey? }`) is validated and accepted, and then ignored — every CMS session produces a brand-new collection in its own `<pathPrefix>/<sessionId>` subfolder. A user who wants to add one audio language to an existing post re-encodes everything, gets a new URL and a new key, and leaves the old collection behind.

**Wanted.** When the CMS sends `existingMedia`, the app should open the collection instead of starting from a blank session:

- **Import** — resolve `hlsUrl` back to a bucket/prefix and use `POST /api/hls/discover` + `POST /api/hls/read` to enumerate what is there: video angles, audio renditions, subtitle tracks, chapters, thumbnails, waveform sidecar. `deriveAngleName` and `normalizeS3Key` in `hls-core/src/keys.ts` already exist for this.
- **Playback with the supplied key** — **done by #162.** `PlayerSource.keyHex` is an input to the player, with no opinion about where it came from, so a key handed over by the CMS works exactly like one from a session the app ran itself.
- **Chapter editing on an imported collection** — the session-scoped chapter routes resolve the prefix from the session's own S3 config; an imported collection needs the same against a discovered prefix (the stateless `/api/hls/chapters/{read,write}` routes already do exactly this).
- **Track management** — add / remove / replace an individual audio track or video angle without touching the rest:
    - new `hls-edit` operations alongside `upsertSubtitle` / `removeSubtitle` / `upsertChapters` / `removeChapters` in `api/src/hls-edit/operations/index.ts` (e.g. `upsertAudioRendition`, `removeAudioRendition`, `upsertVideoAngle`, `removeVideoAngle`)
    - single-track encodes that write into an existing prefix and are encrypted with the **existing collection key**, not a freshly generated one — `EncodeService` currently always calls `encryptionService.generateKey()`, so it needs a path that takes a supplied key. Since #162 that key also has to decrypt the collection's existing playlists before they can be edited and re-encrypt them after, which `hls-edit` already does when given a `keyHex`
    - `If-Match` ETag concurrency on `master.m3u8` via `s3-etag.service.ts` — already wired for mutate, so the new ops inherit it
    - a track-manager UI in `SessionView` (list tracks, mark for removal, add a source file per new track)

**Watch out for.** Segment format and segment duration have to match the existing collection or the new track will not line up; byte-range packing means a "single track" is not a single file; and removing the last rendition of a group leaves a master that no player will accept.

---

## 2. Auto-update

**Today.** There is none, and every update is a manual re-download.

Builds carry an **ad-hoc** signature (`app-electron/build/after-pack.cjs`) but no Developer ID and no notarization, so macOS 15+ blocks a downloaded copy until the user goes through System Settings → Privacy & Security → Open Anyway → a second confirmation → authentication. Right-click → Open no longer works; Apple removed it. Verified on macOS 26.5.2.

**Wanted.** `electron-updater` with a published feed, which requires the whole signing story first:

- macOS: Developer ID Application certificate, `hardenedRuntime: true`, entitlements, and notarization (`notarize` in electron-builder, an app-specific password or App Store Connect API key in CI)
- Windows: an Authenticode certificate (EV or OV; SmartScreen reputation takes time to build with OV)
- A release feed and hosting for the artifacts, plus `publish` config in `electron-builder.yml`
- Update UX in the renderer: notify, download in the background, and **never** restart under a running encode

---

## 3. Linux build

**Today.** No Linux target in `electron-builder.yml`, and no `app-electron/bin/linux-x64/` binaries.

**Wanted.** AppImage and/or deb, plus NVENC-capable ffmpeg builds for the platform.

**The known caveat.** `safeStorage.isEncryptionAvailable()` is false on a desktop with no keyring (or a headless session), and `buildCipher()` in `app-electron/src/main.ts` deliberately returns `undefined` rather than a cipher that quietly stores plaintext. The API then keeps S3 credentials in memory only and logs it once — so on such a system every session is stranded by a restart, which surfaces as "Credentials unavailable after restart — create the session again from the CMS". That fallback works and is honest; a Linux release should decide whether it is acceptable, or whether to prompt the user to set up a keyring (`gnome-keyring` / `kwallet`) as part of onboarding.

---

## 4. Nothing ever deletes a collection from storage

Two separate leaks, one shared difficulty. Neither is implemented.

**Leak one — the document is deleted.** Deleting a blog or page leaves its entire HLS
collection in the bucket: hundreds of objects, the master, every media playlist, the
chunk chains, the sprites and the sidecars. Nothing reclaims them, ever.

Worth being precise about what changed here, because it is easy to read as a
regression and it is half of one. Uploaded audio *was* cleaned up: on a delete request
`processPostTagDto` called `processMedia({ fileCollections: [] }, prevDoc?.media, …)`,
and an empty keep-list meant "delete all the previous files from S3". That path went
when the upload pipeline did. An HLS collection was never covered by it — the old code
only knew `fileCollections`, so it could not have deleted a prefix it had no list of.

The asymmetry is the thing to fix. Images are still deleted on document deletion, by
`deleteImage(prevDoc.imageData, prevDoc.imageBucketId, db)`, three lines above the
comment that says media is not. Media is now the only asset type that leaks.

**Leak two — the collection is superseded.** Every CMS session writes to its own
`<pathPrefix>/<sessionId>/` subfolder, which is what stops a re-encode being half-live
while it runs. But nothing deletes the one it replaced, so re-encoding a post three
times leaves three complete collections with only the newest referenced.

### Where the work belongs

**Leak one belongs in the CMS API**, beside `deleteImage`, not in the encoder. The
premise of the comment currently in `processPostTagDto` — that this API cannot know
which objects belong to the collection — is weaker than it sounds: `media.hlsUrl`
gives the bucket and the prefix, and the API already holds the credentials, since
that is precisely what `GET /storage/encoderconfig` hands out. "List under
`<prefix>/`, delete what is there" is something `S3Service` can already do. The CMS is
also the only party that knows the document is gone; the encoder may not be running.

**Leak two is the encoder's**, or nobody's:

- The CMS sends the previous `hlsUrl` (it can already, via `existingMedia`) and the
  encoder deletes that prefix once the new collection is complete **and the CMS has
  acknowledged the new URL**. Ordering matters: delete after the save, never before, or
  a failed save loses both.
- Or the encoder never deletes, and offers a storage view listing collections under a
  prefix with their dates, for a human to prune.
- Or a retention rule — keep the newest N per `documentId` — which needs a durable
  `documentId` → prefix mapping that outlives the session record. Sessions are purged
  at boot, so that mapping does not exist today.

### Watch out for

**Never delete a prefix we did not create.** This is the part that needs a decision
rather than an implementation, and it got sharper when the Video field became editable:
`media.hlsUrl` is now a value a person can type. It could name a prefix shared with
other content, a bucket root, or someone else's collection entirely. Deleting
everything under a pasted URL's parent path is a data-loss bug waiting to happen.

Candidate guards, none free:

- Delete only when the last path segment parses as the UUID the encoder uses for a
  session prefix — cheap, and matches every collection the encoder has ever written.
- Keep a marker object the encoder writes into each prefix it owns, and refuse to
  delete a prefix without one — sound, but needs the encoder to start writing it, so it
  cannot protect anything already in a bucket.
- Require the prefix to sit under the bucket's configured `pathPrefix`, so a typo
  cannot reach outside the area the CMS was given.

**Deleting a shared bucket is not idempotent.** A failed delete halfway through leaves a
partial collection that is neither playable nor reclaimable by the same code path, so
whatever runs has to tolerate re-running, and report what it could not remove rather
than failing silently.

**Decide immediate or swept.** Immediate is simpler and matches images. A sweep is safer
against a mis-resolved prefix, because a bad decision can be caught before it executes.

## 5. Windows build verification — built, installed, and the NVIDIA path proven

**12 Aug 2026: the first Windows installer was built, and it installs.** The build
runs on a `windows-latest` GitHub runner (`.github/workflows/windows-ffmpeg-verify.yml`),
which produced `Luminary Media Convert Setup 0.0.1.exe` (156 MB, unsigned), and Johan
installed it on a real Windows PC — the installation completed without trouble. Before
this, nothing in this project had ever been built for or run on Windows.

Two Windows-only defects were found in the process, neither reproducible on macOS:
`unzip`/`mv`/`file` do not exist there, and `fs.rename` cannot cross volumes (the
runner's temp is on `C:` while the checkout is on `D:` — `EXDEV`). Both fixed.

**Confirmed by execution on the runner**, not inferred: `cuda` in `-hwaccels`,
`h264_nvenc` / `hevc_nvenc` / `av1_nvenc` / `libx264` in `-encoders`, `scale_cuda` in
`-filters`, and the licence — `--enable-gpl --enable-version3`, so v3-or-later.

**Confirmed on a real Windows PC, 12 Aug 2026:** the installer runs, **SmartScreen did
not warn** despite being unsigned, the app **opens**, and the embedded binaries are in
place — `resources\` holds `ffmpeg.exe`, `ffprobe.exe`, `GPL-3.0.txt` and
`LICENSE-ffmpeg.txt`. It installed under `AppData\Local\Programs`, no admin rights, as
`perMachine: false` intends. The GPL-3.0 text and no GPL-2.0 is the per-build licence
rule working in a shipped install (item 40).

The workflow now asserts this itself rather than trusting it: the packaged
`win-unpacked/resources` must contain both binaries, the notice and a GPL text, and the
shipped `ffmpeg.exe` is run to prove it is real (144 MB, `n8.1.2-34-g9b6c8969e0`).
electron-builder treats a missing `extraResources` source as a *warning*, so
without that step an installer could ship with no encoder and nothing would notice.

**Still unverified, and each needs a Windows machine rather than a runner:**

- **Encoding.** Blocked outside this repository: the CMS has no upload flow yet, and the
  app has no way to open a session without one. Nothing Windows-specific is suspected —
  the binaries are present and the same code path works on macOS
- Whether the encode path handles Windows paths with spaces, once it can be run at all
- `luminary-convert://` protocol registration through the installer
- `safeStorage` (DPAPI-backed, expected to be fine) and the credential sidecar
- The `resourcesPath` lookup with `.exe` suffixes, and paths containing spaces
- ~~**NVENC encoding on real NVIDIA hardware.**~~ **Done, 13 Aug 2026.** Tested by Johan
  on a Windows PC with an NVIDIA GPU, using the cross-compiled binary from
  `ffmpeg-build.yml`:
  - `h264_nvenc` encoded 50/50 frames. There is no software fallback for that encoder —
    without a GPU and driver it fails to load `nvEncodeAPI64.dll` — so this is a real
    hardware encode.
  - The **full pipeline** works: `-hwaccel cuda -hwaccel_output_format cuda` in,
    `scale_cuda` to resize, `h264_nvenc` out, with the output reported as
    `cuda(tv, progressive)` — frames stayed in GPU memory the whole way. This is the
    path `FfmpegService` takes on an NVIDIA machine.
  - `scale_cuda` was the part that could not be verified anywhere else: its CUDA kernels
    are compiled by clang through `--enable-cuda-llvm` rather than NVIDIA's `nvcc`, and
    a GPU-less runner cannot say whether that produces working kernels.

  **Not established: throughput.** Both tests used a 320x240 two-second clip, where
  CUDA context setup and first-run kernel JIT dominate (5.17 s elapsed for 2 s of
  video). A speed comparison needs a 1080p file on local disk, not a network share

**Also needed:**
- Verification of the things that differ from macOS: `luminary-convert://` protocol registration through the installer, `safeStorage` (DPAPI-backed, should be fine), the `resourcesPath` binary lookup with `.exe` suffixes, path handling with spaces (`shellQuote` covers the `execSync` probes; `execFile` callers are unaffected), and whether Windows Defender / SmartScreen blocks an unsigned installer outright
- Confirm the NVIDIA acceleration path end-to-end, which no developer machine in this project can currently exercise

---

## 9. Housekeeping

**Done.**

- **Unused DTOs.** `rendition.dto.ts` and `review-range.dto.ts` removed — nothing referenced any of their four exported classes.
- **Swagger metadata drift.** The hardcoded `2.0.0` outlived the product it belonged to; the docs now report `API_VERSION`, the same value the CMS reads off `/api/cms/health`, so the two cannot disagree. The security-scheme descriptions were reworded.
- **`byteRange` in the status response.** Added. It is fixed at session creation and not editable, so the client had no way to learn it and the encode config form was assuming the API default — right until a CMS asked for anything else.
- **Read-token lifetime.** Recorded as a deliberate decision rather than an oversight, in `session.service.ts`. Its lifetime is the session's, which is a bound the session already has; an expiry shorter than that would break the case it exists for (a CMS watching an encode that can run for hours). What makes that acceptable is written down, along with what would make it unacceptable.
- **Naming.** One thing had four names. The tier is `instance` now, not `master`; the guard holds an `instanceToken`; the env var is `LOCAL_API_TOKEN`, matching the injection token. `MASTER_API_KEY` is still read — it is what every existing `.env` says — but warns, so the deprecation is visible rather than permanent. Verified working with a real fallback.
- **Stale SaaS-era documents.** Moved to `docs/archive-saas/` with a README explaining why their conclusions do not transfer: no shared service, no user database, credentials in an OS keychain, a new perimeter in the origin allowlist, nothing uploaded, and a loopback-only bind. Kept rather than deleted — an audit is evidence of what was examined and when.
- **Prettier baseline.** A `prettier --write` pass over `api/src`, as its own commit.

**Done since.** The security and privacy reviews were re-run against the local-only architecture: `docs/security-review.md` and `docs/privacy-review.md`. The security review found the origin allowlist bypassable by an opaque (`null`) origin — any website could open a session on a user's encoder through a sandboxed iframe, bypassing the approval dialog and the memory of every origin they had refused. Fixed, with the two specs that asserted the old behaviour now asserting the opposite. A second, narrower finding (a read token leaking between two approved sites via `documentId` reuse) was also fixed.

**Where the session key exists, and which of those is worth defending.** Three places, easy to conflate, and only one of them is a real boundary.

1. **At rest in the encoding workflow** — `session.json` in the operator's own user data directory, so a session survives a restart. Plaintext, and accepted (below).
2. **Between the encoder and the CMS or its own UI** — masked, over loopback, from `GET /api/sessions/:id/key`. This is obscurity, not a boundary: it keeps raw keys out of logs, proxies and screenshots, and the code says as much. The formula is published deliberately.
3. **Where a consumer meets it** — the one that matters, and it splits in two. Getting the key from a consumer app's own API into that app is that app's concern, not this repo's. Handing it to the player without making it trivially liftable is this repo's, and is done: the engine adapter serves the key bytes from closure memory through a custom loader, so no blob URL exists and nothing key-shaped appears in the network tab or in the playlist text.

Under all three is the floor of client-side encryption: a viewer who can play the media can recover the key with enough determination. Only DRM changes that answer, and what it would cost is noted with #162.

**From those reviews — one settled, one open.**

- **`encryptionKeyHex` and `readToken` sit in plaintext in `session.json`** — **accepted, deliberately.** The file lives in `<userData>/work/<sessionId>/` on the operator's own machine, mode `0o600`, and exists so a session survives a restart. It is never sent to the CMS, never served to a consumer, and never leaves that machine; the only thing that crosses a boundary is the masked key, over loopback, to the app or the CMS that opened the session. So the reader it protects against is the operator themselves — who already holds the source media, the app, and the S3 credentials in their own keychain. Encrypting these two fields would move the key from a file that user can read to a file that user can decrypt.

    The exposure that would matter is the key being easy to lift where a **consumer** meets it, and that is a different system: delivery from the consumer app's own API is that app's concern, and this repo's part — not handing the player something trivially extractable — is done, since the engine adapter serves the key from memory rather than from a blob URL. What is left there is the honest floor of client-side encryption: a viewer who can play the media can recover the key. Only DRM changes that (see the note in #162).

- **`settings.json` accumulates origins forever.** Prunable by hand in the trusted sites panel; nothing prunes it automatically. A small record of which CMS instances a user has touched, kept for the life of the install.

---

## 10. Player follow-ups (opened by #162)

**Fullscreen on a real device — untested.** The landscape lock on entering, the auto-exit on rotating back to portrait, and the iPhone path that hands over to Apple's own player UI have only ever run in jsdom against mocked `screen.orientation`. `orientation.lock` is reliable on Chromium/Android and a guarded no-op elsewhere, so Android is where the behaviour actually has to be seen. iOS 17.1+ playback (hls.js over `ManagedMediaSource`) needs the same treatment — below that, munged content is refused with a stated reason rather than failing obscurely, which is also worth seeing once.

The transport belongs to the same trip, now that the fullscreen redesign has put three buttons in the middle of the picture where there was one. They hold the 44 px minimum and separate on a fluid gap as the viewport narrows, but that is a claim about the stylesheet: whether skip-back, play and skip-forward can be told apart and hit with a thumb, on a phone held in landscape, is not something jsdom or a desktop pointer can answer.

**Scrub preview in the fullscreen scrubber — done.** The existing sprites are wired into `player-web`'s scrubber, so previews work on web and Android with no encoder change. What remains untested is the same thing as everything else in this item: how it behaves under a thumb, on a real device.

That is worth settling before reaching for **I-frame playlists** (`#EXT-X-I-FRAME-STREAM-INF`), which are tempting because they are the HLS-native answer and turn out not to be portable: AVPlayer uses them, ExoPlayer ignores them, hls.js gives no preview UI either way. They earn their keep in exactly one case — deferring to Apple's built-in player chrome in a Capacitor app — and cost an extra extraction pass at encode time, since FFmpeg's HLS muxer cannot emit them. Wherever we draw the controls ourselves, a sprite sheet is one image and one crop. The lossless parser already round-trips the tag, so adding them later disturbs nothing.

**`encryptPlaylists` has no UI.** It follows `encryption.enabled` and can only be overridden through a direct `POST /api/sessions` — neither the CMS handshake nor the app offers the opt-out. That is the right default; the question is whether anything needs to reach the escape hatch, which the stock-player check in item 0 decides.

## 19. Split divider between the player and the side pane is too bright in dark mode

**Today.** The vertical rule is `.session-split-handle__bar` in `app/src/components/session-view/SessionPlayerStrip.vue` (styles from line 543). Its rest colour is `slate-200` with a `:global(html.dark)` override to `slate-700/60` — but on screen in the dark theme it reads as a near-white line running the full height of the view, far louder than anything else on the page.

**Worth checking first whether the dark override is applying at all**, since `slate-200` is exactly what a failed override would look like. If it is applying, then `slate-700/60` is simply too bright against this background and wants to come down. The hover / focus / active states (sky, 2px) are doing their job and should stay — the rest state is the problem.

---

## 40. Embed FFmpeg so no user ever meets the install prompt — and settle the licence that lets us

**Where this stands today, because it is half-done rather than not started.** A packaged build already carries its own `ffmpeg` and `ffprobe`: `dist:mac` / `dist:win` run `fetch-binaries`, and `electron-builder.yml` copies them in through `extraResources`. `bundledBinary()` prefers them over anything on PATH whenever `app.isPackaged`. Verified: the packaged app was launched with `PATH=/usr/bin:/bin` — no system ffmpeg reachable — and still reported `Apple Silicon detected, using VideoToolbox acceleration`.

So the install prompt is a fallback. **Wanted: make that true of every user, on every platform, from every build path** — and as of 12 Aug 2026 the macOS side is there, verified on each route:

| How the app is run | Where FFmpeg comes from | Checked |
|---|---|---|
| Installed (packaged) | `Contents/Resources/` | launched with `PATH=/usr/bin:/bin`, found FFmpeg 8.1 + VideoToolbox |
| From source (`dev:electron`) | `app-electron/bin/<platform>-<arch>/` | same, same result |
| `pack` on a clean clone | fetched, then packaged | 0 missing-source warnings; app then ran with PATH scrubbed |
| `dist:mac` / `dist:win` | fetched, then packaged | the fetch fails hard rather than shipping without |

**The from-source case is new and was the interesting one.** `bundledBinary()` used to return early when `!app.isPackaged`, reasoning that "a developer running from source has neither, and their own install is the right one". That was true when the repository carried no binaries and wrong once it does — it left the one person able to notice a problem testing against a different FFmpeg from every user. It now resolves `app-electron/bin/<platform>-<arch>/` in development, so a developer who has run the fetch once gets the shipped build.

What remains between here and "no user, anywhere, ever" is Windows, below.

### 1. `dist:win` cannot produce a bundled build at all

`TARGETS` in `fetch-binaries.mjs` has one entry, `darwin-arm64`. Asked for Windows, the script stops:

```
✗ No binaries defined for win32-x64. Known: darwin-arm64.
```

**Done — a `win32-x64` entry exists**, pinned to a dated BtbN `autobuild-*` release (their `latest` tag moves, and a moving URL cannot carry a digest) with the SHA-256 GitHub publishes for the asset. Fetching it works: 297 MB for the pair, against 99 MB on macOS, so a Windows installer will be noticeably heavier.

**Verification now has somewhere to happen: a Windows runner.** The capability checks have to *run* the binary, which a Mac cannot do for a `.exe`, so `.github/workflows/windows-ffmpeg-verify.yml` runs the fetch on `windows-latest`, where the probes execute for real and a build missing `h264_nvenc`, `scale_cuda` or `libx264` fails the job instead of reaching an installer. It optionally builds the NSIS installer through the actual `dist:win` command and uploads it, which is the first time that path will have run at all.

**No GPU is needed for that**, which is the point worth knowing: `-encoders`, `-hwaccels` and `-filters` report what was *compiled in*, not what the machine can do. A GPU-less runner can prove the build has NVENC. What it cannot prove is that NVENC *encodes* — that still wants real NVIDIA hardware, and stays in item 5.

Making that possible meant making the fetch script cross-platform. It shelled out to `unzip`, `mv` and `file`, none of which exist on a Windows runner: extraction now goes through `tar` (Windows 10+ ships bsdtar, which reads zips, matches wildcards and strips path components), the move through `fs.rename`, and the architecture check reads the executable's own header — Mach-O magic and cputype, or the PE COFF machine field — which is both portable and more precise than pattern-matching `file`'s English output.

Triggered manually, and automatically when the pinned URL, digest or packaging config changes — because a new pin is exactly when "does this build have NVENC" is unanswered again. Manual by default because this is a private repository and Windows minutes bill at a multiple of Linux ones.

**The old claim that most published Windows builds lack NVENC is settled, and it was false.** `strings` could not settle it — `h264_nvenc` and `scale_cuda` appear in the binary, but so does `videotoolbox`, which cannot work on Windows, so those come from name tables rather than proving compiled-in support. The runner answered it properly: `cuda` in `-hwaccels`, `h264_nvenc` / `hevc_nvenc` / `av1_nvenc` / `libx264` in `-encoders`, `scale_cuda` in `-filters`.

**The runner also earned its keep immediately by finding a Windows-only defect on its first run.** `fs.rename` cannot cross volumes, and there the temp directory is on `C:` while the checkout is on `D:` — `EXDEV`. No macOS run can reproduce that, because everything is one filesystem. Staging now sits inside `app-electron/bin/` so the move stays on one volume. That is the second Windows-only fault this work has surfaced, after `unzip`, `mv` and `file` not existing there — which is the argument for the runner in one line.

**`dist:win` now runs, and its output installs.** The installer step was gated behind the `package` input, which only `workflow_dispatch` supplies — and that needs the workflow on the default branch. A push to `ci/windows-pack-*` now asks for it too, which produced the first `.exe` (156 MB, unsigned); Johan installed it successfully on a Windows PC on 12 Aug 2026. What the install does *not* establish is that the app launches or encodes there — see item 5.

**The first `dist:win` attempt failed, and the bug was not Windows-specific.** `build:libs` compiled `segment-editor` before `hls`, which it imports from, so `vue-tsc` had no declarations: `TS2307 Cannot find module '@luminary-media-converter/hls-core'`, and `TS7006` on a callback parameter as a consequence of the unresolved type. Invisible on a development machine, where `hls/dist` is left over from an earlier build. **Any clean clone could not build** — the runner was simply the first thing to try. Order now follows the dependency direction.

### 2. `pack` produced an app with no encoder, silently — fixed

`pack` skipped `fetch-binaries` on the reasoning that a `--dir` smoke test should not pull 100 MB, and electron-builder treats a missing `extraResources` source as a *warning* rather than an error. The result started, served the UI and showed the install prompt: fine for a developer who knew, a trap for anyone handed that directory. It fetches now, like `dist:mac` and `dist:win`, so no packaging path can produce an app without an encoder. Verified by deleting `app-electron/bin/darwin-arm64/` and packing: it fetched, packaged with zero missing-source warnings, and the resulting app found FFmpeg with `PATH` scrubbed to `/usr/bin:/bin`.

### 3. The binaries come from one third-party host

`osxexperts.net` — one person's site, whose URLs change with every FFmpeg version. The pinned digest covers **integrity**; nothing covers **availability**, so `dist:mac` breaks the day that host moves or disappears.

**Asked of Ivan (12 Aug 2026): how should we source them?** The options, with what each costs:

- **Mirror to somewhere we control** (a GitHub release asset on this repo, or BCC S3), keep the pinned digest, keep `osxexperts.net` in the README as provenance. Availability under our control, integrity unchanged, no repository growth. Roughly an hour.
- **Commit them to the repo.** Fixes availability, but git history is permanent: ~98 MB per platform per FFmpeg bump, forever. GitHub warns above 50 MB per file and refuses above 100 MB, and these are 49 MB each — shipping at the warning line. It also puts a GPL binary inside an Apache-2.0 source tree, which muddies the repository's own licensing story more than fetching one at build time does.
- **Leave it.** Cheapest until the day it isn't.

### 4. The licence has to permit distribution — and this is the release blocker

`LICENSE-ffmpeg.txt` ships beside the binaries and states the position: the osxexperts build is **GPL v3 or later**; this app invokes ffmpeg as a separate process and never links its libraries, so the obligation travels with ffmpeg rather than with this Apache-2.0 codebase. `README.md` calls that "a technical reading, not legal advice", which is the honest description of it.

**Investigated — see [`docs/ffmpeg-licensing.md`](docs/ffmpeg-licensing.md).** Three findings changed the picture:

- **The build is GPL v2-or-later, not v3.** `ffmpeg -L` says so and `-buildconf` shows `--enable-gpl` without `--enable-version3`. `LICENSE-ffmpeg.txt` claimed v3, which understated our recipients' options and linked the wrong licence text. Corrected.
- **It is distributable at all**, which was the thing genuinely worth checking: no `--enable-nonfree`. A nonfree build cannot be redistributed on any terms, and that is the trap here — it usually arrives via `libfdk-aac`.
- **We are not compliant today, and it is the source obligation rather than the notice.** `x264` and `x265` are *statically linked* into the shipped binary (`otool -L` shows no dynamic reference to either), so the corresponding source covers FFmpeg **and** both libraries at the versions built. The FSF is explicit that redistributing someone else's unmodified binary still obliges the matching source, and that "corresponding" means what the binary can be rebuilt from — so pointing at ffmpeg.org's current download page does not discharge it.

The fix is the same action as §3 above: publish the binary and its corresponding source together somewhere we control, and point the notice there. One change closes the availability risk and the compliance gap at once, and GPL v3 §6(d) explicitly allows source and binary to live at different URLs provided the instructions are clear and the source stays up for as long as the binary is distributed.

**What still has to happen before anything is distributed publicly:**

- **Publish the corresponding source** beside the binary (FFmpeg 8.1 + x264 + x265 at the built versions + the configure line). This is ours to do, not a decision to wait for.
- Someone at BCC confirms the GPL v2-or-later position is acceptable for an Apache-2.0 application shipping the binary as an aggregate. The aggregate itself is on firm ground — the FSF's own FAQ puts arm's-length `fork`/`exec` with command-line arguments on the "separate programs" side — with one condition to keep: if the installer ever gains an EULA, it must not forbid what the GPL grants for the FFmpeg part.
- **A separate question the GPL does not touch: H.264 patents.** FFmpeg's legal page notes that implementations may be subject to patent rights and that distributors of H.264 encoders have had demands from pools such as MPEG LA. Complying with the GPL says nothing about this. `libx264` is the exposed piece; the VideoToolbox and NVENC paths use encoders supplied by the OS or driver, which is a different position.
- If it is not acceptable, the alternative is an LGPL build — which **omits `libx264`**, the CPU fallback in `FfmpegService`. A machine with no VideoToolbox and no NVENC would then be unable to encode at all, which is the one case bundling exists to serve. The other route is `libopenh264`, which needs the encoder detection adapting.

That decision is a prerequisite for a public release, not for internal use, and it belongs with whoever owns licensing rather than in this repository.

## 41. Use Tailwind as far as it reaches, and know where it stops

**Asked for as a side note.** Written with the numbers, because "use Tailwind more" reads differently once you see where the CSS actually is.

**The app is already Tailwind-first.** `app/src/style.css` imports Tailwind v4, defines its palette in `@theme`, and puts shared surfaces in `@layer components` with `@apply` — the input field, the page container. What is left as hand-written CSS in app components is 215 lines across four files, and it is nearly all keyframes and gradients (`ProgressBar`'s shimmer, `SessionPlayerStrip`'s split handle). Those are the cases Tailwind does not express cheaply, so they are not the opportunity.

**The mass is in the shared libraries, and it is 3,315 lines:**

| Package | CSS | Custom properties | Tailwind? |
|---|---|---|---|
| `segment-editor` | 1,677 lines | 101 | no |
| `encode-config` | 1,181 lines | 0 | no |
| `player-web` | 457 lines | 19 | no |

**Why they are like that, and why the answer is not simply "convert them".** A component library that ships Tailwind classes puts a build requirement on its host: the consumer must run Tailwind *and* have the library in its content globs, or every class silently does nothing. Self-contained CSS is what makes these drop-in. That reasoning still holds for `player-web`, which exists to be embedded in the Luminary app and later a Capacitor shell — it should stay self-contained, and this item should not be read as licence to change it.

It holds less well for `segment-editor` and `encode-config`. Both are `private: true`, both are consumed by exactly one host, and that host has Tailwind v4. So the argument for their 2,858 lines is weaker than it looks — but converting them is a large diff over a timeline with real pointer arithmetic and 224 tests, for a maintainability gain rather than a user-visible one. Not obviously worth it, and worth nobody's afternoon by accident.

**What is practicable, in order of value for effort:**

1. **Keep the palettes from drifting.** The libraries carry their own tokens, and the app carries Tailwind's. The timeline's buttons showed the consequence: the timeline's buttons were blue-950 while the app's were slate, so the timeline read as borrowed from another application. The fix was to set the library's token to the Tailwind value the app uses. Doing that deliberately across the remaining tokens — surfaces, borders, text, danger — is cheap and removes a whole class of "looks like two apps" bugs.
2. **New app-side UI uses Tailwind.** No retrofit, no risk; it is already the default and only needs stating so nobody adds a `<style scoped>` block out of habit.
3. **Only then consider `encode-config`.** It is the better candidate of the two — 1,181 lines and *zero* custom properties, so it has no token system to preserve, and it is a form rather than an interactive canvas. If any conversion happens, it starts there and stays there until it has proven itself.
4. **Leave `segment-editor`'s and `player-web`'s CSS alone** unless something else forces it. The first is a canvas whose layout maths the tests do not cover; the second has hosts beyond this repository.

**What would change the calculus:** if `player-web` or `segment-editor` are ever published for real, self-contained CSS stops being a choice and becomes a requirement — and item 41 is then closed by decision rather than by work.

---

## 42. Discard belongs beside Start encoding, and the player controls should wrap under them

**Asked for.** Two changes to the row under the player:

1. **Move `Discard session` down** out of the topline (`SessionTopline.vue`) and put it
   next to `Start encoding`, which lives in `SessionView.vue` inside the player strip's
   default slot. The two are both actions on the session, and pairing them puts the
   destructive one where the constructive one already is.
2. **When the column narrows, `Audio` / `Quality` / fullscreen should wrap below those
   two buttons** rather than competing with them on one line. They are in the player
   strip's `#aside` template today, on the same row.

**Note the interaction with item 43.** Moving `Discard session` out of the topline
removes the widest `shrink-0` element from that row, so it will make the overflow in 43
less visible — without fixing it. The title still collapses first. Do 43 as a layout
fix in its own right, not as a side effect of this.

**Where.** `app/src/components/session-view/SessionTopline.vue` (the discard and delete
buttons, and their `discard` / `delete` emits), and `app/src/views/SessionView.vue`
around the `Start encoding` button and the `#aside` template. The topline renders in two
places — inside the player column and standalone before there is a player — so both
paths need checking, and `SessionView.spec.ts` asserts on `discard-session` /
`delete-session` test ids.

---

## 43. The session topline overflows its column and drops the title

**A visual bug, seen when the encode-config panel is open** and the player column
narrows: the session name disappears entirely, and `Discard session` is clipped by the
panel — the row runs underneath it.

**Two separate causes, both in `SessionTopline.vue`:**

1. **Line 92: the row itself is `shrink-0`.** `class="session-topline flex min-w-0
   shrink-0 items-center gap-2 pb-2"` — so when its column narrows the row keeps its
   intrinsic width and overflows rather than fitting. That is why the discard button
   ends up under the neighbouring panel instead of staying inside the column.
2. **Line 124: the title is the only element that can shrink.** It carries `min-w-0
   truncate`, while the back arrow, the `|`, the `·` separators, the status badge and
   `Created just now` are all `shrink-0`. When width runs out, flexbox takes it from the
   only thing that will give — so the **session name** truncates to nothing while
   `Created just now`, which nobody needs at that moment, keeps its full width.

**The ranking is upside down.** In a cramped row the useful order is: back arrow,
title, status, then the timestamp as the first thing to go. Options: let the row shrink
and give `Created just now` a `min-w-0 truncate` or hide it below a breakpoint; and give
the title a sensible `min-w` so it degrades to a few characters plus an ellipsis rather
than vanishing.

**Worth a test.** The suite renders this component; a case at a narrow width asserting
the title is still present would pin the behaviour, since this is the sort of regression
that only shows up when someone opens a side panel.

---

## 44. A downloaded macOS build could not be opened — fixed

**The defect.** `extraResources` copies the encoder and its licence texts into the
bundle *after* Electron's own signature was made, which invalidates it.
`mac.identity: null` means electron-builder never re-signs, so the app shipped with a
signature describing a bundle that no longer matched. macOS reads that as corruption,
not as "unsigned", and refuses a downloaded copy outright:

> «Luminary Media Convert» er skadet og kan ikke åpnes. Du bør flytte det til papirkurven.

Move to Bin or Cancel. No way through. Every user downloading the dmg would have got
this.

**Fixed** by `app-electron/build/after-pack.cjs`: ad-hoc sign after packing, before the
installer is built, then verify — so an inconsistent signature fails the build instead
of reaching someone's screen. Runs once per architecture; confirmed for arm64 and x64.

**Why it survived so long, which is the part worth remembering.** Gatekeeper only
assesses bundles carrying `com.apple.quarantine`, which browsers attach to downloads
and a local build does not have. Every install on the machine that produced the build
worked perfectly. Reproduce a real user's conditions with:

```bash
xattr -w com.apple.quarantine "0081;0;Safari;$(uuidgen)" <dmg>
```

**What ad-hoc signing does and does not buy.** The app is openable; it is not trusted.
On macOS 15+ the user must dismiss a malware warning, open System Settings → Privacy &
Security, click **Open Anyway**, dismiss a second warning, click it again, and
authenticate — seven steps, with "Move to Bin" as the highlighted default throughout.
Right-click → Open was removed by Apple and no longer helps. Verified on macOS 26.5.2.

**Outstanding:** notarization removes the prompt entirely and needs the Developer ID
certificate that auto-update also requires — see item 2. That is one purchase with
three payoffs, and belongs in the same conversation as the GPL sign-off in item 40.

---

## 45. Quick trim: smart cut — implemented, player verification pending

**Implemented** (branch `feat/lossless-cut`): a trim submitted with every stream in
copy mode is cut as a smart cut — whole GOPs remuxed, only the partial boundary GOPs
re-encoded as closed-GOP bridges, spliced per stream with `#EXT-X-DISCONTINUITY` +
per-part `#EXT-X-MAP`, frame-exact on any source at near-remux speed. No config field:
the copy checkboxes are the mode (all copy = quick cut, none = precise, mixed =
refused). Eligibility is the relaxed cadence-only gate (`quickTrimGateRejection`) —
the alignment rule does not apply, because each stream splices on its own keyframe
grid; the mutually offset sources the full copy gate refuses are the case this exists
for. Planner rejection or a runner failure falls back automatically to the precise
re-encode with a `fallbackNote` on the session status. Mechanics, measured rules and
switch points: [`docs/quick-trim.md`](docs/quick-trim.md).

**Verified so far**: full unit/integration coverage (planner matrix, runner
command-lines, measure-retry convergence, spliced-structure survival through the
byte-range rewrite and key fencing); an end-to-end run on the misaligned reference
source through the real API on the VideoToolbox path — per-grid bridges, four
one-GOP-early seek landings each converged on the single retry, uniform six-part
discontinuity structure across both video grids and audio, chunk chains packed.

**Still open, gated on a browser sitting** (`docs/stock-player-check/` cases 6–9,
upload commands in the README): the hls.js + Safari verdict on the spliced shape, the
`KEY:METHOD=NONE`/re-arm fence vs the encrypted-inits alternative (case 7 vs 8 — the
code switches either way: the fence lives in `EncryptionService.injectKeyTag`,
`MAP_EVERY_PART` in the runner), and whether a copy-split part may inherit the
previous part's init given ffmpeg stores the part start in the init's `elst`
(case 9; if not, the planner flips `ownInit` to always-true). Plus one full
S3-backed session (LMCENC + key fencing on real spliced output) and the chunk-warming
drift check across discontinuities noted in `docs/chunk-warming.md`.

**Known limitation, accepted**: ffmpeg's own HLS demuxer mishandles mid-playlist MAP
switches; quick-trim output is for the supported players, precise mode remains the
maximally portable output.


---

## 46. The trim timeline's audio waveform is not in sync with the audio — fixed

**Was exactly the suspected head offset, plus three relatives found on the way.**
`WaveformService` bucketed peaks from the first decoded audio sample, and the trim
UI draws peak 0 at timeline zero — on a source whose audio starts ~0.98 s into the
presentation, the whole waveform sat that far early (and stretched, since the peaks
also ended at the audio's end rather than the timeline's).

**The fix, all in `api/`** (`waveform.service.ts`, threaded from `ingest.service.ts`,
`encode.controller.ts`, `encode.service.ts`, `ffmpeg.service.ts`):

- Peak 0 now means timeline zero: `aresample=8000:async=1:first_pts=0` fills the
  head gap with silence. `-copyts` is deliberately **not** used on a direct input —
  ffmpeg's rebase onto the container start is the zero the client draws from, and
  with `-copyts` an MPEG-TS recording stamped at wall-clock PTS hands `first_pts=0`
  hours of "gap" to fill (measured: 57 MB of PCM for a 10 s file).
- The tail spans the timeline: `apad=whole_dur=<durationSec>`, with the duration
  passed from the probe (source) or the summed trim ranges as clamped by
  `buildConcatFile`'s in-points (trimmed).
- A trimmed sidecar no longer contains concat seek pre-roll: the waveform pass
  mirrors the encode's `-segment_time_metadata 1` + `aselect=concatdec_select` +
  `-copyts` trio.
- The **delivered** sidecar describes the delivered media: `EncodeResult` now
  reports `alignmentOffset`, and the encode-time sidecar removes the same head the
  encode's alignment seek removed (`-ss` before `-i`, sample-accurate for audio).
  The session-scoped cache keeps describing the source, which is what the trim UI
  scrubs.
- Sidecar `version` is 2; version-1 caches are rejected on read and recomputed, so
  a session restored from before the fix heals on first request.

Verified by decoding the produced commands against the misaligned reference source:
sample counts exact to the timeline (`duration × 8000`), leading silence matching
the audio's real start, argv byte-identical to before on the untouched paths.
Full api suite green. Left open: a waveform requested in the narrow window between
file attach and probe completion caches with no tail padding (no `durationSec`
yet) — benign unless the audio ends early, noted here rather than machinery added.

---

## 47. Intel Quick Sync — code path present, unverified on hardware

`FfmpegService` detects Quick Sync and uses it: `AccelMode` gains `'intel'`,
`detectIntelQsv()` requires the `qsv` hwaccel, the `h264_qsv` encoder *and* the
`vpp_qsv` filter (a build with the encoder but no scaler would pick the path and then
fail on every ladder), and both the encode and preview paths keep frames on the GPU
with `-hwaccel qsv -hwaccel_output_format qsv`. Detection is ordered after NVIDIA, so
a machine with both a discrete card and an iGPU uses the faster one. Reported as
`encoder: 'intel'` on status and SSE.

**Why it matters:** ordinary office Windows PCs have Intel integrated graphics and no
discrete card. Without this the `h264_qsv` in the Windows binary is never asked for and
those machines encode on CPU.

**Unverified, and only Intel hardware can settle it** — the same position NVENC was in
until it was tested on a real GPU. What needs seeing:

- `encoder` reports `intel` on an Intel Windows machine (a session status is enough)
- an encode completes, and the output plays
- `vpp_qsv` accepts the frames `-hwaccel qsv` produces. This is the pairing most likely
  to fail: the NVIDIA equivalent had exactly this bug, where a hwaccel that returned
  software frames could not feed a GPU-only scaler
- a preview segment generates. A QSV failure there retries on CPU, so it degrades
  rather than breaks

CPU fallback is unaffected: a machine without the encoder fails detection and encodes
with `libx264` as before.

---

## 48. Delivered thumbnails drift out of sync after trimming

**Reported, not yet investigated.** After a trimmed encode, the scrub thumbnails no
longer match the frames they preview — the sprite cue shows a moment visibly away
from where the playhead lands. Observed on the multi-stream test source whose
streams start apart (alignment offset ~1.06 s).

**The suspects, unverified but familiar.** `ThumbnailService.packForDelivery` maps
source-timeline thumbs onto the output timeline, and makes two assumptions the
waveform sidecar was just cured of (item 46):

1. **`outDuration` sums `(outSec - inSec)` unclamped**, but `buildConcatFile` writes
   `inpoint = max(inSec, alignmentOffset)` — a trim range starting inside the head
   region contributes less than its face value, so every cue after it sits late by
   the difference. The waveform fix's Defect B was this same reduce; the corrected
   form is in `encode.service.ts`'s sidecar block.
2. **The non-trim path uses `sourceDuration` and no offset at all**, while the
   encoded output starts at source `t = alignmentOffset` and is that much shorter —
   so on a misaligned source the delivered storyboard should be wrong even without
   a trim, cues early by ~the offset throughout. `EncodeResult.alignmentOffset`
   exists now (added for the waveform); `packForDelivery` never receives it.
3. `selectThumbsForOutput` picks source thumbs per output position via the ranges —
   whatever mapping it applies inherits both errors above; check it against the
   clamped in-points rather than the raw trim ranges.

**Where.** `api/src/encode/services/thumbnail.service.ts` (`packForDelivery`,
`selectThumbsForOutput`, `orderedRanges`), threaded from `encode.service.ts` where
`encodeResult.alignmentOffset` is already in scope. The pre-encode source storyboard
(trim UI filmstrip) draws on the source timeline and should be unaffected — verify
rather than assume.

## 49. How should the app display open-source licence texts?

**Asked for by the product owner, 31 August 2026** — *"Guess we need to do a round of
research on how we should display the open source license texts."* Research first,
then a decision; this is not a defect with an obvious fix.

**Where it stands.** The Licences window shows a full text per shipped binary
component — FFmpeg, libwebp, libvpl on Windows, the LGPL, and now Electron and
Chromium — read from `resourcesPath` at runtime, so it describes the build that
actually shipped rather than a list someone remembered to update.

**The gap.** Nothing covers the npm dependency tree. Around 277 licence files ride
along inside `app.asar` with their packages, which arguably satisfies the letter of
the permissive licences that ask for a notice to travel with the distribution, but
nothing surfaces them and nobody has curated them. `LICENSES-chromium.html` is the
same shape of problem already met once: 9 MB is past what a window can show, so it
is offered as a file to open instead.

**What the research has to settle.**

- Whether a generated manifest (`license-checker`, `oss-attribution-generator`) is
  worth adding to the build, and whether it runs against the packaged dependency
  set rather than the whole dev tree — the two differ by a lot.
- What a person is actually meant to do with several hundred notices. Chrome's
  answer is one long `chrome://credits` page; a searchable list and a single
  concatenated text are both defensible, and the choice should be made rather than
  fallen into.
- Whether the copyleft-adjacent cases in the tree need separate treatment from the
  MIT/BSD/ISC bulk. Worth an actual audit of what licences are present, not an
  assumption that it is all permissive.
- Whether this belongs in the app at all or in a `NOTICE` file beside the build.

**Related.** `app-electron/src/licences.ts` builds the window; the notices it reads
are written by `ffmpeg-build/build.sh` and `app-electron/build/after-pack.cjs`, and
`app-electron/scripts/verify-package.mjs` fails the build when one is missing.
