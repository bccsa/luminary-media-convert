# Todo — follow-up work

Deferred work and known gaps after the local-only Electron migration. Each item states what exists today, what is missing, and where the work lands. Nothing here is a bug report against shipped behaviour; these are things deliberately left for later.

Ordered roughly by value, not by effort.

---

## 0. Handover state (read this first)

**Branch.** All migration work (issue #154) is on `154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features`, open as PR #161. The original seven logical commits (SaaS removal → hls lib → api → app → cms-mock → electron → docs) have since been joined by the manual-verification fixes, the app icon, a merge of `main`, and the restored test suites.

**Build state.** All workspaces build, and all test suites pass: api 815, app 215, encode-config 34, segment-editor 217, hls 121, player-core 168, player-web 79 (item 6). `vue-tsc` typechecks the specs again. A packaged macOS `.app` and `.dmg` were built and verified to boot the embedded API, serve the UI, and carry the app icon.

**Player extraction (issue #153, PR #162) has since landed on top of this branch.** Playback logic left the app for two packages — `player-core` (headless: munging, controller, recovery, polling) and `player-web` (hls.js reference implementation) — Video.js is gone, and encryption now covers playlists, chapters and subtitles rather than segments alone. Items below are marked where that work closed or changed them.

**Manual verification — mostly done.** A full pass was run through the Electron app and `cms-mock` against a local MinIO: CMS handshake and idempotency, TOFU origin gating, local-file ingest by reference, probe, trim, encode, SSE with `hlsUrl` + `encryptionKeyHex`, encrypted playback via the `luminary://key` swap, chapters, session delete, and credential recovery across a restart. Several defects were found and fixed in the process (storyboard cue clipping at a trim in-point, trim semantics, timeline duration during an encode, playhead clipping at the ends, waveform contrast on an audio source, storyboard polling on a source with no video track).

- [x] **Storyboard poll died on the first request after an upload, so the trim timeline needed a manual reload.** A regression of the last fix above: `404` became the client's signal for "no frames will ever exist", but the endpoint also answered `404` for "sampling started and has written no sprite yet" — which is the state of nearly every first poll, since sampling begins on that very request. One stopped poll presented as four unrelated faults: no filmstrip, no "Generating thumbnails…" badge (`pending` is `active && !complete`), the waveform drawn in its no-filmstrip colour, and no dark bottom fade — the last two because both belong to a filmstrip that was never there. The transient case now answers `200` with an empty body and `X-Storyboard-Complete: false`, which is what the polling contract already expected; the two permanent cases still `404` before any sampling is attempted, so an audio-only source still stops asking at once. Covered by a regression test that fails without the fix. Fixed alongside it: the waveform retry chain abandoned itself when `canEditTrimTimeline` was false as the timer fired, neither fetching nor rescheduling, which left the peaks flat until a reload — the same "not yet" read as "never".

Still outstanding:

- [x] Multi-angle source: single `master.m3u8` with `#EXT-X-MEDIA:TYPE=VIDEO` groups in S3; angle switching + audio-only in the app player (client-side extraction). **Verified** against S3 output with #162 — angle, audio-track and quality selection all confirmed working.
- [x] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the _default angle_ of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls/` helpers depend on this. **Now has a second half:** with #162 an encrypted session also encrypts its playlists (LMCENC), which no stock player can read at all — such a client needs `encryption.encryptPlaylists: false` until it moves to `player-core`. Worth testing both, since the answer decides whether that opt-out is a transitional courtesy or a permanent mode. **Answered — §0a**, across ffmpeg, hls.js and Safari's native HLS. Both halves came back worse than the item assumed: the opt-out is not sufficient on its own, and a stock player does not stay on one angle.

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

So `extractAnglePlaylist` is not a nicety for these clients: **a Luminary client that will not adopt the `hls/` helpers should be sent single-angle output.**

Two things observed and dismissed:

- Cases 1 and 2 emit `Invalid NAL unit size` / `missing picture in access unit` under ffmpeg when opened **through the master**, never through the media playlist directly, and decode 300/300 frames over 10 s regardless. That is ffmpeg probing a byte-range fMP4 fragment without first reading its `#EXT-X-MAP` init segment — an artefact of the probe, not a defect in the output. Absent on case 5 because an encrypted fragment cannot be probed that way at all.
- Chrome's native `<video src>` path fails all five with `MEDIA_ERR_SRC_NOT_SUPPORTED`. That is Chrome having no built-in HLS, not a finding about the output.

**Re-run 2026-08-13, against the shared-chunk-chain layout** (section 11: `media/<chain>_<n>.m4s` chunks referenced as `../media/…`, always fMP4): all five verdicts identical — hls.js at default config plays cases 1, 2 and 5, byte ranges into the shared chunks included, and fails 3 and 4 exactly where designed. The layout change is invisible to stock clients. The known ffmpeg-CLI probe artefact reappeared on case 2 and was isolated further this time: it needs two same-codec video variants demuxed concurrently by ffmpeg itself, reproduces over `file://` with fully disjoint URL sets, and no real player drains variants that way — the bytes decode clean in isolation and by range-reconstruction. Raw verdicts in `results-2026-08-13.md`. Safari-native was not re-run (headless pass, Chromium only); the 8-11 Safari findings stand, and a hand re-check is one `serve.py` away.

**Settled by the Safari run:** the byte-range fMP4 output is playable by Apple's own stack (cases 1, 2 and 5 all played), so nothing about the segment format or the byte-range packing needs revisiting for iOS web. Case 5 was the genuine unknown — Safari is stricter than hls.js about both fMP4 and key delivery — and it played, which means the "readable playlists + real `keyUrl`" configuration does work everywhere. It is still not one to recommend, for the key-delivery reasons above, but it is not a web-only trick.

**Still untested, and out of scope here:** the native players a Capacitor shell would use — AVPlayer and ExoPlayer — which is item 6's problem, not this one. Safari's native HLS is AVFoundation underneath, so case 5 playing is weak evidence in AVPlayer's favour; ExoPlayer has been given none. Video.js, named in the original item, was not tested separately: on desktop it wraps hls.js, so it inherits that column.

**Outstanding: the browser half.** ffmpeg settles the structure but is not hls.js and is not Safari. A harness is committed for that — [`docs/stock-player-check/`](docs/stock-player-check/README.md), which loads hls.js with **default config** (no custom loader, no munging, no key injection) and offers a native-`<video>` button per case for Safari's built-in HLS. Its README has the two commands. Expected per the table above; the interesting rows are 2 (does hls.js's ABR actually cross angles?) and 4 (does it report a key error or a manifest error?). Note the whole exercise settles the *web* only — AVPlayer and ExoPlayer remain untested, which matters when the Capacitor adapters land (item 6).
- [ ] Queue: three CMS sessions encoding FIFO with SSE `queuePosition` updates.
- [ ] Protocol handler from a packaged install: `open luminary-convert://` launches/focuses the app.
- [ ] Packaged mac build encodes with `encoder: 'apple'` (VideoToolbox). **No longer blocked on item 5a, and no longer falling back to PATH.** A `pack` build was launched and probed while closing item 33: it boots, serves the client from its own resources, reports "Apple Silicon detected, using VideoToolbox acceleration", and shuts down cleanly on `SIGTERM` (queue teardown ran, port released, no orphan ffmpeg). The package carries arm64 `ffmpeg`/`ffprobe` whose only hwaccel is `videotoolbox`, and `bundledBinary()` prefers `process.resourcesPath` whenever `app.isPackaged`, so a machine with no system ffmpeg is covered. What is still unproven is an **encode** through the packaged app — the instance token is minted per launch and handed only to the renderer, so driving one from outside needs the UI. Caveat for a clean clone: `pack` does not run `fetch-binaries` (only `dist:mac` / `dist:win` do), so a `--dir` build on a machine that has never fetched them ships without ffmpeg.

---

## 0b. CMS-side integration (bccsa/luminary — out of this repo)

The encoder's half of the contract is done and documented (CLAUDE.md "CMS contract"; `cms-mock/` is the executable reference). The Luminary side still needs, on branch `1878-api-cms-hls-media-data-model` or successor:

- The "upload / edit media" button: health-check `GET /api/cms/health` on `http://127.0.0.1:31711`, `luminary-convert://` launch fallback, then `POST /api/cms/sessions` (Chrome LNA; Chrome-only at time of writing).
- SSE consumer on `eventsUrl`: on the first `encoding` event, save `MediaDto { hlsUrl, hlsKey }` — the post can be saved before encoding completes. **Changed by #162:** the key no longer rides on the event. Fetch it from `GET /api/sessions/:id/key?token=read_…` and unmask it (XOR with `SHA-256(sessionId)[0..16]`, self-inverse); `cms-mock/src/store.ts` (`captureHlsKey`) is the reference. A CMS still reading `encryptionKeyHex` off the frame will silently get `undefined`.
- Player-side: **adopt `@luminary-media-converter/player-web`** (or `player-core` with an adapter) rather than wiring the `hls/` helpers by hand — it already does angle extraction, the `luminary://key` swap from memory, quality capping, chapters, subtitles, recovery, and the "not available yet" state as a `coming-soon` slot that polls until the playlist appears. Since #162 an encrypted session also encrypts its playlists and VTTs, which only these packages can read.
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

## 0c. Deployment workflows — decided and removed

**Resolved: running the API as a shared remote service is no longer a supported mode.** The deploy workflows and `api/Dockerfile` are gone.

The architecture decided this, not the cleanup. `DEFAULT_HOST` is `127.0.0.1` unconditionally, and the comment on it says why: nothing here is meant to be reachable from the network the machine is on. The perimeter for any remote caller is a browser-origin allowlist with a native approval dialog — a control that only means anything when the approver is sitting at the machine. S3 credentials arrive per session and are sealed with an OS-keychain key belonging to the logged-in user. `docs/security-review.md` rests its every conclusion on one process, one user, one machine, and says so in its closing section.

Keeping workflows that deployed the API as a long-running container to a remote host would have been worse than untidy: they would have been the only documentation of a deployment nobody could safely run. And they would have broken on merge — the generated `.env` carries no `HOST`, so the process would have bound loopback inside its own container namespace and been unreachable through `docker run -p`, failing the health check after replacing the container already there.

Removed: `.github/workflows/api-deploy-{prod,staging}.yml`, `api/Dockerfile`, `api/.dockerignore`. `api-unit-tests.yml` stays — it is the CI that guards the branch.

**One thing this cannot do for you.** If a staging or production container is still running on `za-scc-dhe03`, nothing here stops it. It is running the old SaaS-era API against a CouchDB and an Auth0 tenant that this branch removes; it will simply go stale rather than break. Decommissioning it is a manual step on that host.

**If the decision is ever reversed**, it takes more than restoring these files: `HOST=0.0.0.0` in the generated environment, a pass over variables the current API no longer reads (`CORS_ORIGIN` is `CMS_ALLOWED_ORIGINS` now), and — the real work — a fresh answer to the threat model, because an origin allowlist approved by a native dialog is not a perimeter for a service with no one sitting at it.

---

## 1. Edit mode for existing HLS collections

**Today.** `CmsCreateSessionDto.existingMedia` (`{ hlsUrl, hlsKey? }`) is validated and accepted, and then ignored — every CMS session produces a brand-new collection in its own `<pathPrefix>/<sessionId>` subfolder. A user who wants to add one audio language to an existing post re-encodes everything, gets a new URL and a new key, and leaves the old collection behind.

**Wanted.** When the CMS sends `existingMedia`, the app should open the collection instead of starting from a blank session:

- **Import** — resolve `hlsUrl` back to a bucket/prefix and use `POST /api/hls/discover` + `POST /api/hls/read` to enumerate what is there: video angles, audio renditions, subtitle tracks, chapters, thumbnails, waveform sidecar. `deriveAngleName` and `normalizeS3Key` in `hls/src/keys.ts` already exist for this.
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

**Today.** There is none. Builds are unsigned (`mac.identity: null`, `hardenedRuntime: false` in `electron/electron-builder.yml`), so macOS users must right-click → Open on first launch, and every update is a manual re-download.

**Wanted.** `electron-updater` with a published feed, which requires the whole signing story first:

- macOS: Developer ID Application certificate, `hardenedRuntime: true`, entitlements, and notarization (`notarize` in electron-builder, an app-specific password or App Store Connect API key in CI)
- Windows: an Authenticode certificate (EV or OV; SmartScreen reputation takes time to build with OV)
- A release feed and hosting for the artifacts, plus `publish` config in `electron-builder.yml`
- Update UX in the renderer: notify, download in the background, and **never** restart under a running encode

---

## 3. Linux build

**Today.** No Linux target in `electron-builder.yml`, and no `electron/bin/linux-x64/` binaries.

**Wanted.** AppImage and/or deb, plus NVENC-capable ffmpeg builds for the platform.

**The known caveat.** `safeStorage.isEncryptionAvailable()` is false on a desktop with no keyring (or a headless session), and `buildCipher()` in `electron/src/main.ts` deliberately returns `undefined` rather than a cipher that quietly stores plaintext. The API then keeps S3 credentials in memory only and logs it once — so on such a system every session is stranded by a restart, which surfaces as "Credentials unavailable after restart — create the session again from the CMS". That fallback works and is honest; a Linux release should decide whether it is acceptable, or whether to prompt the user to set up a keyring (`gnome-keyring` / `kwallet`) as part of onboarding.

---

## 4. Stale-collection cleanup

**Today.** Every CMS session writes to its own `<pathPrefix>/<sessionId>/` subfolder. That is what keeps a re-encode from being half-live while it runs — but nothing ever deletes the superseded one. Re-encoding a post three times leaves three complete collections in the bucket, and only the newest is referenced by the CMS.

**Wanted.** A strategy, then an implementation. Options, roughly:

- The CMS tells the encoder the previous `hlsUrl` (it already can, via `existingMedia`) and the encoder deletes that prefix once the new collection is complete and the CMS has acknowledged the new URL. Ordering matters: delete after the CMS has saved, never before, or a failed save loses both.
- Or the encoder never deletes and ships a "storage" view listing collections under a prefix with their last-modified dates, letting the user prune.
- Or a retention rule (keep the newest N per `documentId`), which needs a durable `documentId` → prefix mapping that outlives the session record — sessions are purged at boot.

Whatever is chosen must cope with the case where the CMS document was deleted entirely, and must never delete a prefix it did not create.

---

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
electron-builder treats a missing `extraResources` source as a *warning* (item 5a), so
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

## 5a. Bundle ffmpeg/ffprobe binaries — done for macOS

`npm -w electron run fetch-binaries` downloads the pair, checks a pinned SHA-256, verifies the architecture and the encoders the app actually asks for, and writes the GPL licence text beside them. `dist:mac` and `dist:win` depend on it, so a build can no longer quietly produce an app with no encoder in it.

**`pack` is the exception, and it does exactly what the sentence above says it cannot.** `pack` deliberately skips `fetch-binaries` — a `--dir` smoke-test build should not pull 100 MB — and electron-builder treats a missing `extraResources` source as a **warning**, not an error: `file source doesn't exist  from=…/electron/bin/darwin-arm64`, then it packages happily. Confirmed by parking the binaries and packing: an `.app` was produced with the web client present and `Resources/ffmpeg` / `Resources/ffprobe` absent. Nothing downstream notices, because the app starts fine without them — see item 35. Either `pack` should fetch too, or it should fail loudly when the source is missing; the current middle ground is the one that misleads.

**Verified rather than assumed:** the packaged `.app` was launched with `PATH=/usr/bin:/bin` — no Homebrew, no system ffmpeg — and reported `Apple Silicon detected, using VideoToolbox acceleration`, which it can only do by running the bundled binary. The `.dmg` is 146 MB.

Two things checked along the way and recorded in `bin/README.md`: evermeet.cx publishes x86_64 only, which would run under Rosetta on the machines this app targets; and Homebrew's ffmpeg links against eighteen dylibs under `/opt/homebrew`, so it cannot start anywhere those are absent.

**The licence choice is not free.** LGPL builds omit `libx264`, the CPU fallback in `FfmpegService` — without it the app cannot encode at all on a machine with no VideoToolbox or NVENC, which is the case bundling exists to serve. A GPL build ships; ffmpeg runs as a separate process and is never linked, so the obligation travels with ffmpeg rather than with this Apache-2.0 codebase. Worth a look from whoever owns licensing at BCC before a public release.

**Still to do:** `win32-x64`. Add a `TARGETS` entry with the URL, digest and required capabilities (`h264_nvenc`, `scale_cuda`) — the script handles the rest. Folded into item 5, which needs a Windows machine anyway.

---

## 6. Restore the test suites — done

**Done.** Every workspace is green, and `vue-tsc` typechecks the specs again.

| Workspace         | Result              |
| ----------------- | ------------------- |
| `api/`            | 23 files, 795 tests |
| `app/`            | 12 files, 192 tests |
| `segment-editor/` | 5 files, 217 tests  |
| `hls/`            | 9 files, 121 tests  |
| `player-core/`    | 12 files, 168 tests |
| `player-web/`     | 4 files, 58 tests   |

Rewritten against what the code does now rather than patched into passing. Two suites were deleted rather than repaired, because their subject moved: the angle and audio-only playlist generation in `ffmpeg.service` (the encoder writes one spec-correct master and the player narrows it), and everything about webhook delivery in `encode.service` (the CMS watches over SSE).

New coverage for what the migration added and nothing tested: `OriginRegistry` (33) and `CmsController` (31) — the origin allowlist is the whole perimeter for a remote caller, since the API binds to the loopback interface of someone's laptop. Credential redaction and restore in `SessionService` is covered too.

**Two defects the new tests found**, both fixed here:

- `createCorsOptions` promised in its own comment to refuse by withholding the header and never by raising, but called `registry.isAllowed(origin)` before building the promise, so only an async rejection was caught. `isAllowed` has a synchronous return path and calls the host's approver directly — a native dialog throwing synchronously would have become a 500 on a request the API meant to quietly turn away.
- `encode.service.spec` constructed `EncodeService` with eight services when it takes seven, so every assertion in that suite was made against the wrong object. `encode.controller.spec` had the same fault with nine.

**Since done by #162.** `hls/src/angles.ts` extraction against real multi-angle masters — the coverage deleted from `ffmpeg.service` has its home back, and then some: `angles.spec.ts`, a parity suite pinning the rewritten extraction to the behaviour of the line-based original, and byte-for-byte round-trip fixtures for multi-angle, audio-only and byte-range playlists. `player-core` and `player-web` arrived with their own suites (see the table).

**Still worth adding.** `cms-mock/` has no tests at all, deliberately: it is a dev-only bench, nothing depends on it, and its bugs surface immediately in use.

Also removed with this work: the dead `node-tusd` alias in `api/vitest.config.ts`, and the `src/**/*.spec.ts` exclusion in `app/tsconfig.app.json`.

---

## 7. Origin trust management UI — done

Trust decisions were made once in a native dialog and were then unreachable: a user who clicked "Block" on their own CMS was locked out of their own encoder with no route back inside the product, only a settings file to find and edit by hand.

Denial memory moved from the Electron host into `OriginRegistry`, which is the decision point the CORS layer already consults on every request. Holding it in two places would have meant a revocation had to reach both, and only one of them takes effect without a restart.

- `OriginRegistry` gains `decisions()`, `revoke()` and an `onDecisionsChanged` callback; the host supplies both lists at boot and writes back whatever the registry decides.
- `GET`/`DELETE /api/origins`, instance-token only — a site able to read the allowlist would learn which others to impersonate.
- `TrustedSitesPanel` on the sessions list, listing allowed and blocked sites with a remove action. No new route: there is no nav to reach one with, and the list is the screen every launch lands on.

Deliberately over HTTP rather than on the preload bridge, which keeps one set of rules about what the renderer may do. Covered by 12 new registry tests and 7 panel tests — one of which caught the panel claiming "No site has asked yet" beside a connection error, which is a reassuring thing to say and not something a failed request is evidence for.

---

## 8. Session focus refinement in the Electron main process — done

`onCmsSessionCreated` now routes the session id through to the renderer instead of discarding it. The window used to come forward on whatever the user was last looking at, so a CMS opening a session for a different post showed them the wrong one.

Two arrivals are covered, because they differ in whether a renderer exists yet: a push over IPC when the window is already up, and a one-shot claim on mount when the click that created the session also launched the app through the protocol handler. The claim is one-shot on the host side, so a later reload does not yank the user back to a session they have moved on from. Navigation uses `replace`, since arriving there is not a step the user took.

`app/src/composables/useCmsSessionRouting.ts`, covered by 7 tests including the plain-browser case where there is no preload bridge at all.

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

The transport belongs to the same trip, now that item 30 has put three buttons in the middle of the picture where there was one. They hold the 44 px minimum and separate on a fluid gap as the viewport narrows, but that is a claim about the stylesheet: whether skip-back, play and skip-forward can be told apart and hit with a thumb, on a phone held in landscape, is not something jsdom or a desktop pointer can answer.

**Scrub preview in the fullscreen scrubber — done** (item 31). The existing sprites are wired into `player-web`'s scrubber, so previews work on web and Android with no encoder change. What remains untested is the same thing as everything else in this item: how it behaves under a thumb, on a real device.

That is worth settling before reaching for **I-frame playlists** (`#EXT-X-I-FRAME-STREAM-INF`), which are tempting because they are the HLS-native answer and turn out not to be portable: AVPlayer uses them, ExoPlayer ignores them, hls.js gives no preview UI either way. They earn their keep in exactly one case — deferring to Apple's built-in player chrome in a Capacitor app — and cost an extra extraction pass at encode time, since FFmpeg's HLS muxer cannot emit them. Wherever we draw the controls ourselves, a sprite sheet is one image and one crop. The lossless parser already round-trips the tag, so adding them later disturbs nothing.

**`encryptPlaylists` has no UI.** It follows `encryption.enabled` and can only be overridden through a direct `POST /api/sessions` — neither the CMS handshake nor the app offers the opt-out. That is the right default; the question is whether anything needs to reach the escape hatch, which the stock-player check in item 0 decides.

## 11. Always fMP4, and shared chunk chains — **done**

Shipped on `todo-11-always-fmp4-chunk-chains`, in three phases with a normative spec for the player half in `docs/chunk-warming.md`.

### 11a. Always fMP4 — done

The MPEG-TS fallback is gone. A source whose used streams start ≥ 20 ms apart (the gate came down from 50 ms) is aligned with an **input seek** to the latest-starting stream's start — `-ss` before `-i`, or a bumped concat `inpoint` when trim segments are present — so every stream loses the same head, timestamps stay honest, and output is always fMP4. Lip-sync was **measured, not assumed**: a synthetic flash/beep rig source survived to ~9 ms, and a real multi-camera VOD (7 video tracks starting up to 1 s apart, 15 audio) round-tripped with −0.4 ms of A/V drift by content cross-correlation. FFmpeg's single-process demux→transcode→mux already provides the PTS-honoring "sync=true" semantics; GStreamer was not needed.

**Copy-mode became a gated privilege** rather than a hope: the source track must not be early-starting on a misaligned source (an input seek cuts copied streams at keyframe granularity — permanent desync), and its keyframe cadence must be regular and divide the segment duration, compared in frames so NTSC rates pass, strict on unknowns. Enforced at the encode endpoint (`copy-mode-eligibility.ts`), mirrored in the form from new probe fields (`startTime`, `gopFrames`, `gopSeconds`, `gopRegular`). The GOP probe reads the pict_type as the first CSV field — ffprobe appends SEI side data to the frame's row, and the old whole-line match saw no keyframes at all in ordinary H.264.

Deleted as dead: `byte-range.worker.ts`, `convertToByteRange`, the `byteRange`/`preByteRangeHook` encode options, the GOP-derived `hls_time` override (never active in production). `segmentFormat` stays in the API contract, always `'fmp4'`; `'mpegts'` survives only on sessions restored from before the change.

### 11b. Shared chunk chains — done

Byte-range packing now builds **one chunk chain per video angle** (every rendition of that angle, segments interleaved by arrival) and **one audio chain** (every audio group), under `media/` at the prefix root, referenced from per-stream playlists as `../media/<chain>_<n>.m4s`. On an edge that forwards a requested range while backhauling the whole object, one backhaul warms every quality of the playing angle — an ABR step-up never lands on a cold object. No cross-stream barrier exists: byte order inside a chunk is irrelevant to a whole-object backhaul, so streams append as they arrive under the poll loop's existing serialization.

Sizing is two-step, not a ramp: chunk 0 closes at ~20 s of the chain's content (fast edge warm-up at play-start), every later chunk is cap-sized — each extra object is a billed storage operation, and intermediate sizes buy nothing once ranges pass through immediately. Video chains use `byteRangeMaxFileSizeMB` (500); the audio chain got its own `audioByteRangeMaxFileSizeMB` (default 50 — it aggregates every language and quality, so a wide ladder raises it). A segment larger than its chain's cap logs a warning: the resulting over-cap chunk may be uncacheable at the edge, and that failure mode is otherwise silent.

Chain identity is passed in from the encode config (`FfmpegService.buildStreamChainMap`), never parsed from directory names; an unmapped directory degrades to a private per-stream chain with a warning. Fixed en route: the fMP4 init is no longer uploaded mid-encode — FFmpeg creates it empty and fills it moments later, the first-sight upload raced that write and shipped zero-byte inits (a black frame at playback), and the upload dedup then sealed them. Inits travel with the remaining files at the end, complete by construction.

### 11c. Next-chunk warming in the player — done

Chunk boundaries are the one place playback can hit a cold object, and they are predictable from the playlists. `player-core` builds per-chain boundary schedules (`buildChunkSchedules` — pure, serializable) and owns the policy (`PlayerControllerOptions.prefetch`: enabled, `leadSeconds` default 60, `warmBytes` default 64 KiB, `debug` console instrumentation); the pacing loop is **adapter work** via the optional `PlayerAdapter.warmChunks` contract, implemented for the web by `ChunkPrefetcher` in `player-web` — deliberately in the reference adapter, because a JS interval is throttled in the background exactly when a native player keeps playing, so a Capacitor AVPlayer/ExoPlayer adapter re-implements the loop natively against `docs/chunk-warming.md`. The trigger is the **buffer front** (`max(bufferedEnd, currentTime)`), not the playhead — the engine crosses a boundary tens of seconds before the viewer does. One 64 KiB ranged request per chunk object per session, marked before fetching, never retried, failures swallowed.

The munge fast path went with this: every source now fetches and rewrites its media playlists, so behavior (and warming coverage) no longer depends on whether a source happened to be encrypted or capped. One deliberate consequence: a master whose variant playlist is unreachable fails loudly (`fetch-failed`) instead of soft-loading.

**Still open from this work:**

- The warming loop for **native adapters** does not exist yet — it is specified (`docs/chunk-warming.md`) and reference-implemented (`player-web/src/adapter/chunkWarming.ts`), but the Capacitor shell will need it written beside AVPlayer/ExoPlayer, in platform scheduling primitives.
- `serveDecryptedVttSegments` (player-core) fetches subtitle segment URIs **whole**, ignoring `#EXT-X-BYTERANGE`. Subtitles are sidecars today, so nothing is broken — but byte-range-packed subtitle playlists would make that path fetch entire chunk files and decrypt them as single VTTs. Known, deliberate deferral.
- A dev-only **test harness** exists at `npm -w player-web run demo`: any master URL + optional key through the real player, with transport controls and warming logs. Worth remembering before wiring a session through the app just to eyeball output.

---

## 12. Saved chapters never appeared in the player — done

**Reported as** "chapters are not saved to S3": authoring chapters produced no `chapters/en.vtt` in the bucket, and fetching one returned 404.

**The write was never broken.** Verified live against the local MinIO: a chapter authored in the editor landed at `<pathPrefix>/<sessionId>/chapters/en.vtt` within seconds, `LMCENC01`-wrapped for that encrypted session, and decrypted with the session key to exactly the authored cue.

**The read-back was, and for every session.** `playerChapterSidecars` in `SessionView.vue` built its URL from `deliveryBaseUrl`, which is the **bucket root** — correct for the values it was written for, because everything the API records is a full object key including the session folder (`masterPlaylist` is `<sessionId>/master.m3u8`, `thumbnailsVtt` likewise, and `files[]` too). Sidecars are not keys: the convention is `<masterFolder>/chapters/<lang>.vtt`, relative to the folder the master sits in. Appending that to the bucket root dropped the session folder, so the app asked for `media/chapters/en.vtt` and got a 404 every time. Chapters were written correctly and then never displayed.

**Why it stayed hidden.** The code treated a missing sidecar as unremarkable — "a sidecar that 404s costs the player nothing — it reports the miss and plays on" — so a URL that was wrong on every session never failed loudly. The name did the rest: `deliveryBaseUrl` reads as "the folder the master is in", and is not.

**Fixed** by a second computed, `masterFolderUrl`, taken from the delivered URL with its last segment removed — the delivered URL being the one value certainly right, since the encoder built it and the CMS was handed it. Both computeds now carry docblocks saying which resolves keys and which resolves sidecars. Two tests in `SessionView.spec.ts`, confirmed to fail with the fault re-introduced; the second uses a nested prefix (`shows/ep12/<sessionId>/`), which the naive fix of appending the session id to the base would pass while still being wrong.

**Fixed alongside it:** `GET /api/sessions/:id/chapters` answered 404 when a language had no sidecar yet. The client already read that as "none", but the browser logs a failed request regardless, so a session nobody had authored chapters for carried a permanent console error — and that error is what the original report was looking at. It answers `200` with an empty document now; 404 on that route means the session does not exist. The stateless `/api/hls/chapters/read` keeps its 404, where a caller supplying its own bucket and prefix genuinely is asking whether one object exists.

**Two things that still mislead anyone checking a sidecar by hand.** The object is under `<pathPrefix>/<sessionId>/`, not the base prefix — the CMS handshake bakes the session id into `pathPrefix` at creation. And on an encrypted session it is `LMCENC01` ciphertext, so even the right URL returns bytes rather than readable WebVTT; `docs/encrypted-sidecar-format.md` has the layout and the key is the session's `encryptionKeyHex`.

**One genuine failure path remains.** `sessionStorage()` refuses with `400 — storage credentials no longer available` for a session whose S3 keys did not survive an app restart, so a save on such a session really does fail. `onSaveChapters` surfaces it rather than swallowing it, but it is the one route by which authored chapters are actually lost.

---

## 13. Remove the Delivery tab

**Today.** A completed session's aside offers two tabs, Chapters and Delivery (`app/src/views/SessionView.vue`, the completed-phase tab switcher around line 2132 and the delivery panel around line 2398), and `SessionWorkflowPanel.vue` points at it on completion ("Encoding finished. Delivery links are on the Delivery tab").

**Wanted.** Drop it. Everything it surfaces — `hlsUrl` and the key — already reaches the Luminary CMS over SSE and the key endpoint at encode *start*, and the CMS is what owns delivery. Showing it again in the encoder invites someone to copy a URL out of the wrong place.

**What that touches.** With Chapters the only remaining completed-phase panel, the tab switcher goes with it and the panel renders unconditionally; the `completedAsideTab` state and the `switchTab` emit from `SessionWorkflowPanel` lose their reason to exist, and that panel's completion message needs new wording. Check whether anything else still needs `SessionPostProcessPanel`'s delivery half — and, if the removal leaves the session view with no way to see the output URL at all, decide deliberately that this is fine rather than by omission.

---

## 14. Move "Clear All" out of the timeline controls and into the Chapters section — done

**Today.** `SegmentEditor` renders the Clear All button itself, in its controls row, in every non-`trim` mode where at least one segment exists — twice over, since the row has two render sites (`segment-editor/src/SegmentEditor.vue`, the standalone toolbar around line 1641 and the combined controls bar around line 2070; in `trim` mode the same slot holds Cut instead). So a destructive "remove every chapter" action sits among playback, mark in/out, undo/redo and zoom, which are all timeline-local and mostly reversible-by-habit.

**Wanted.** It belongs beside the chapter list, where the things it deletes are actually visible.

**What that takes.** `clearAll` is already on the component's `defineExpose` surface, so the host can call it — what does not come with it is the confirmation dialog (`confirmClearOpen`, and the "Clear all {{ clearNoun }}?" sheet around line 2386), which either has to be reachable from outside or re-implemented in the chapters panel. Note that the button is generic to non-trim modes, so removing it unconditionally also takes it away from `subtitles` mode; if that mode is meant to keep an in-editor clear, this needs a prop rather than a deletion. `segment-editor` is a published library with its own suite — check for tests asserting the button's presence.


**Done.** Moved to the chapter list's own `list-actions` header, beside the chapters it deletes. The two traps the item named were handled rather than stepped in: the button is now behind a `showClearAll` prop (default true) so `subtitles` mode — where the editor is the only place the cues live — keeps its clear; and the confirmation did not have to be rebuilt, because the component exposes `requestClearAll()` which opens the sheet it already has. Ungating the `list-actions` template moved the `canSaveChapters` condition onto the save controls themselves: a session that cannot save chapters can still empty the list locally, which is what undo is for.
---

## 15. Session topline belongs in the left pane, not in a full-width top bar

**Today.** The session topline — back arrow, title, status badge, "Created 17 hours ago", and the encode action — is a full-width row above both columns (`app/src/views/SessionView.vue`, `.session-topline` around line 1752, rendered above the `SessionTrimWorkspace` that draws the player and its `#aside` slot). The aside therefore starts one row down, and the chapters pane opens with a band of empty space above it.

**Wanted.** Move the topline inside the left (player) column, so the aside runs to the top of the window and the chapters pane starts there. The title also reads better beside the thing it names than as a page-wide chrome bar.

**Watch out for.** The topline carries the encode submit button, which is the primary action of the pre-encode phase — narrowing its row to the player column has to leave it somewhere it is still obvious. It also has an `order-first` special case for the `trim` tab, and the back arrow is the only route out of the session view.

---

## 16. Chapters pane: too much left and right padding — done

**Today.** The chapters panel insets its content well away from the panel edge on both sides, which costs the chapter-title field width — the part of each row that actually needs it — while the timecode, duration and remove controls stay fixed.

**Wanted.** Tighten the horizontal padding. Worth doing together with item 15, since both are about the same pane's use of space, and with item 13, which removes the tab row above it.


**Done, and the padding was the symptom.** The title field was losing ~40px a side to three nested insets, and the middle one came with a border, a background and a shadow — the editor was drawing a second card inside the bordered panel that already held it. Passing `embedded`, the variant the library has for exactly this, removes the card and the 20px with it. Row spacing untouched; the vertical rhythm was not the complaint.
---

## 17. Timeline control buttons do not match the rest of the app — done

**Today.** The controls bar under the timeline (mark in/out, undo/redo, step, play/pause, zoom) is styled entirely from `segment-editor/src/styles.css`, which carries its own theme tokens. In dark mode `--se-track: #172554` / `--se-track-hover: #1e3a5f` (line 69–70) give every `.se-btn` a deep navy fill, while the app's own buttons around it are slate. So the timeline reads as a component borrowed from somewhere else.

**Wanted.** Bring the button surfaces onto the app's palette — for the dark theme that is the slate family, not blue-950.

**Play/pause needs a separate decision.** `.se-btn--playback` (line 584) is the only button given the accent treatment: sky border, `--se-accent-soft` fill, sky icon. Against navy neighbours that reads as an outlined toggle rather than the primary control, and on a slate bar it will read differently again. Worth deciding what it should be — solid accent fill, or plain like its neighbours since the timeline already has a keyboard space bar and a playhead to say what is happening — rather than just recolouring what is there.

**Note.** `segment-editor` is a published library with its own token block and a light theme alongside the dark one, so this is a change to the library's defaults (both themes) or a set of overrides the app supplies — decide which, because the library is meant to be host-agnostic.


**Done.** Button surfaces split out of `--se-track` into `--se-btn-bg` / `--se-btn-bg-hover`, so the timeline and scrollbar keep the track fill and the things you click get the host's palette — slate-800/700 in dark, which is what the app paints its own buttons with. Play/pause, the separate decision this item asked for: it was an accent border over an accent wash, which is this library's vocabulary for a *toggled-on* state, and play/pause is not a toggle. Filled now, with its own foreground token because white on the dark theme's sky-400 is barely legible, and its own hover rule so the generic `.se-btn:hover` cannot drop it back to a plain surface mid-press.
---

## 18. Theme popup: smaller, icons instead of tick-boxes, close on select — done

**Today.** `app/src/components/AccountMenu.vue` opens an 18rem panel with an "APPEARANCE" heading and three rows, each a bordered square that holds a checkmark when selected, a bold label and a second line of description ("Always light" / "Match system" / "Always dark"). `pickTheme` (line 86) sets the preference and leaves the panel open.

**Wanted.**

- Smaller overall — the panel is wider and taller than three mutually exclusive options need.
- Icons in place of the tick-box column (sun / auto / moon), matching how the Luminary app presents the same choice. Selection then has to be shown some other way — a highlighted row or a tinted icon — since the checkmark is what carries it today.
- Close the popup on selection. `close()` already exists; `pickTheme` just does not call it.

**Watch out for.** The rows are `role="menuitemradio"` with `aria-checked`, which is the part that must survive losing the visible checkbox; and the same component renders in two places via the `variant` prop (`editor` uses the `se-btn` trigger inside the timeline controls bar, the default is the round nav button), so both placements need looking at. Dropping the description line may make the labels alone ambiguous — "Auto" is the one that carries its meaning least well on its own.


**Done.** 18rem and four rows down to 11rem and three: sun, half-lit circle, moon. Heading dropped (the menu already carries `aria-label="Appearance"`), descriptions dropped from the panel but kept as each row's `title` and accessible name — "Auto" is the one label that does not carry its own meaning. Selection moved from the checkbox column to the row fill and icon colour; `role="menuitemradio"` + `aria-checked` stayed, which is the invisible part a redesign drops without noticing, and is now covered by tests. `pickTheme` closes the panel.
---

## 19. Split divider between the player and the side pane is too bright in dark mode

**Today.** The vertical rule is `.session-split-handle__bar` in `app/src/components/session-view/SessionPlayerStrip.vue` (styles from line 543). Its rest colour is `slate-200` with a `:global(html.dark)` override to `slate-700/60` — but on screen in the dark theme it reads as a near-white line running the full height of the view, far louder than anything else on the page.

**Worth checking first whether the dark override is applying at all**, since `slate-200` is exactly what a failed override would look like. If it is applying, then `slate-700/60` is simply too bright against this background and wants to come down. The hover / focus / active states (sky, 2px) are doing their job and should stay — the rest state is the problem.

---

## 20. Timeline timecode is over-emphasised — done

**Today.** `.se-controls-bar__time` (`segment-editor/src/styles.css`, line 799) is `1rem` monospace at `weight: 600` in full `--se-text`, while the buttons beside it are `0.75rem` at `weight: 500`. It is the loudest thing in the controls bar, and it is a readout rather than a control.

**Wanted.** Smaller, or lighter, or both — enough that the transport buttons lead the bar. Monospace should stay: the digits must not jump width as the playhead moves.

**Note.** There is a second readout with the same treatment — `.se-time-above` (line 929), `0.9375rem` at `weight: 600`, used when the controls are not in the combined bar. Both should move together, or the two layouts will disagree.


**Done.** 1rem/600 to 0.8125rem/500 — the buttons' own weight — with the colour left at full `--se-text` because it is still read at a glance; size and weight were what was shouting. Monospace kept. `.se-time-above` moved with it, as the item required.
---

## 21. Move "Start encoding" below the video player

**Today.** The button sits at the right end of the session topline (`app/src/views/SessionView.vue`, around line 1825, `v-if="showProbeConfig"`), which is the full-width bar above both columns. It got there from the app header, on the reasoning that an action on this session belongs on the session's own row — but that row is the furthest point on screen from the settings the button acts on.

**Wanted.** Below the player, in the left column.

**Do this with item 15**, which moves the topline into the player pane and so disturbs the same markup; doing them separately means moving this button twice. Whatever lands has to keep the disabled state and the title that explains it ("Open Encode settings and complete the ladder…"), which is the only thing telling a user why the button will not respond.

---

## 22. Audio language codes are not restored automatically — done

**The hypothesis was right.** ffprobe reports the literal `und` for a stream with no language tag, `probe.service.ts` passed `s.tags?.language` straight through, and the fill-blanks-only guard in `applySavedTrackLabels` is `overwrite || !track.language` — `und` is truthy, so a saved language was never restored. Track names have no equivalent placeholder, which is why they came back and languages did not, and why the omission read as arbitrary rather than as a rule.

**It cannot reproduce on this repo's test media.** Both fixtures in `test-media/` carry real tags (`eng, spa, fra, deu`), and every session on disk records them correctly — so with those sources the guard skipping the saved value is *correct behaviour*: the file's own metadata wins. Reproducing it needs a source with untagged audio; one is made in seconds with `ffmpeg -i … -c copy -metadata:s:a:0 language= …`, and ffprobe then reports `und` on every track. Worth knowing before anyone tries to see this fail with the files to hand.

**Fixed at the probe boundary**, which is what the item asked to decide. The deciding evidence was that `und` was already special-cased in four places across three workspaces: `audioGroups.ts` buckets by `track.language || 'und'` and normalises it back out before building a config, `SessionView` filters it out of a label, and `preview.service` uses it as a display fallback. Three readers had to remember a third case and one forgot — the definition of a convention belonging upstream of all of them. `normalizeLanguage()` in `probe.service.ts` now maps `und`, empty and whitespace-only tags to `undefined`, on audio *and* video streams, since both carry the same tag.

Nothing downstream needed changing: `audioGroups.ts`'s `|| 'und'` fallback makes an absent language and the literal indistinguishable, and `trackLabels.ts` is fixed without being touched — so the comment there warning against widening `overwrite` stays honoured, which was the point.

**The read-side guards stay deliberately.** `SessionView`'s `language !== 'und'` is redundant for fresh sessions but not for restored ones: a `session.json` written by an earlier build still carries the literal, and those are read back at boot.

**This reaches the wire.** `probeResult` travels on the status response and over SSE, so a consumer sees `audioTracks[].language` absent rather than `und`. Same meaning, better expressed, but not a silent change.

11 tests: 7 on the probe (including `UND` casing and a padded ` deu `), 2 on `applySavedTrackLabels` — a saved language landing on a track that has none, and still refusing to overwrite one the source carries — and 2 pinning that `audioGroups` builds identically from `undefined` and from `'und'`, which is the assumption the whole change rests on.

**Found while testing, not acted on.** `isAlreadyABR` is `videoTrackCount > 1 && hasMultiAudioPerLang`, and it cannot tell "several encodings of one language" from "several languages, none tagged" — because untagged tracks all share one bucket. So an untagged multi-track source with more than one video track is read as an ABR ladder and each tier points at a different audio track, which is the shape of the hd→ENG / mid→FRA regression that function's own docblock describes. Pre-existing and unchanged by this work; possibly correct for genuinely-ABR sources. Worth its own item if it matters.

---

## 23. Validate language codes — done

**Today.** Language is a free-text input in two places in `encode-config/src/EncodeConfigForm.vue` — per audio track (line 680, placeholder `und`) and per audio group (line 1085, placeholder `eng`). Nothing validates or normalises what is typed, so a typo, a two-letter code or a stray capital travels straight into `#EXT-X-MEDIA:LANGUAGE=` and out to every player.

**Wanted.**

- Accept only valid ISO 639-2 three-letter codes.
- Lower-case on input, so `ENG` and `eng` are the same entry rather than two.
- `mul` and `und` must both pass — they are real ISO 639-2 codes (multiple languages; undetermined), not escape hatches, and both already appear in this app's own output.

**Decide.** Whether an invalid code blocks the encode or only warns, and whether the check is client-side only or also on `EncodeConfigDto` — the API accepts an arbitrary string today, and `POST /api/sessions` is a supported integration surface, so a validator in the form alone leaves the gap open for the CMS route and any direct caller.

**Note.** ISO 639-2 has B/T variants for some languages (`ger`/`deu`, `fre`/`fra`), so the accepted set has to include both or reject codes that are perfectly valid. Interacts with item 22: if `und` is going to be treated as "absent" for label restoration, it still has to remain a *valid* thing to type.


**Done, from the register rather than from memory.** `encode-config/src/language-codes.ts` is generated from the Library of Congress file at `https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt` — the maintenance agency's own list — because a hand-written subset is a list of the codes whoever wrote it happened to think of, and every omission refuses a language someone speaks. 506 codes with their English names, both the bibliographic and terminology forms (`ger` and `deu` are both German, and refusing either refuses a correct answer).

Both inputs lower-case and strip to letters as you type, capped at three, and mark themselves when what they hold is not a code — marked rather than cleared, since `en` is a reasonable thing to type on the way to `eng`. The `title` says which language a valid code is, or that an invalid one is not one. A shared `<datalist>` makes the names searchable, because nobody remembers whether German is `ger` or `deu` and both are right.

`mul` and `und` pass, as the item required — they are codes, not escape hatches, and this app already emits `und`. Empty passes too: an unstated language is a normal state and the encoder writes no `LANGUAGE` attribute rather than guessing one.

**Two things the register taught us**, both found by tests rather than by reading:

- It contains `qaa-qtz`, which is a *range* reserved for local use, not a code — the generator swallowed it as a literal until a test asserting every code was three letters caught it. The range is now matched by pattern (`/^q[a-t][a-z]$/`) and kept out of the picker, since only the person using one knows what it means. Accepted rather than refused: an unregistered language is the case the range exists for.
- ISO 639-2 has only `que` for Quechua. `quz` is 639-3, which this field is not — and 639-3 has thousands of codes that do not belong in a `LANGUAGE` attribute.

Validation lives in `encode-config` and is exported from the package, so a host collecting a language elsewhere uses the same register and the same rules rather than forming a second opinion. It pairs with the API-side fix that stopped writing `und` as a *language* when a stream simply had no tag: that closed the reading side, this closes the writing side.
---

## 24. `npm run dev` should work with no `.env` files — done

A fresh clone plus `npm install` plus `npm run dev` now gives a working browser dev environment. Verified by parking both `.env` files and running it: the API starts, `X-API-Key: dev-token` is accepted, a wrong token is still refused with 401, and the origin allowlist admits `localhost:5173` and `localhost:5199` while refusing anything else.

**Where the defaults live.** `api/src/dev-defaults.ts`, called from `main.ts` after `dotenv` and before `createServer` — after, so a real `.env` always wins, and before, because the providers read the environment at module init. It fills only gaps, so `.env` goes back to being for overrides rather than for the minimum. On the client, `import.meta.env.DEV` guards a token fallback in `auth-token.ts` and an `API_BASE` of `http://127.0.0.1:3000` in `api.ts` — the standalone API's own default port, deliberately not Electron's `31711`, since browser dev is paired with `npm -w api run dev`.

**It announces itself.** Applying a dev token silently is the failure this item warns about, so the API logs a warning naming exactly what it defaulted and that `NODE_ENV=production` disables it. A silent gate would be the more dangerous design: the log line is the only thing distinguishing "configured" from "defaulted" at a glance.

**Confirmed it cannot follow the code into a build.** Built with no `app/.env`, the bundle contains neither `dev-token` nor `127.0.0.1:3000`, and keeps the throw — `import.meta.env.DEV` is false for every `vite build`, so both branches are eliminated. The desktop app is unaffected either way: it hands `createServer()` a token minted per launch and an origin policy with a real approver, and never runs the standalone entry point.

**The `LOCAL_API_TOKEN`-unset note is addressed too**, though not as this item framed it. No token still means key auth is disabled and every request is accepted — that is legitimate, and it is how the API runs before anyone sets one — but it is indistinguishable at runtime from a working instance. It now says so at startup rather than leaving the security model switched off in silence. Behaviour is unchanged; only the silence is.

13 tests: 6 on the defaults (production gate, never overriding, filling only the missing half, leaving a deprecated `MASTER_API_KEY` in charge, and warning exactly once), 4 on the token fallback including the bridge still winning and the throw surviving outside dev, and 3 on `API_BASE`.

**Found while testing, not changed.** Vite folds env values into the bundle at build time, so a build made on a developer machine bakes in whatever `app/.env` says — `VITE_API_TOKEN` and `VITE_API_URL` both appear as literals in `app/dist`. Harmless for the packaged app, whose renderer takes its token from the preload bridge before ever reading the env, but it means packaging must not run against a developer's `.env`. Worth confirming what `electron-builder` actually builds from before the next release.

**Not covered:** `cms-mock` still defaults its API base to `31711`, the Electron port, so pointing it at a browser-dev API on `3000` is still a manual edit in its own UI. The value persists to `localStorage`, so it is a one-time step rather than a recurring one.

---

## 25. Keyboard shortcut for Cut in trim mode — done

**There is one already**, which makes this a discoverability or a reachability problem rather than a missing feature — worth establishing which before building anything. `Delete` and `Backspace` both call `deleteSelected()` (`segment-editor/src/SegmentEditor.vue`, line 1044), the trim workspace mounts the editor with `keyboard-scope="global"` so the window listener is attached, and the Cut button's own tooltip advertises it: "Cut the selected range · Delete".

Three things could make it feel absent:

- **It needs a selection.** `deleteSelected` returns immediately when nothing is selected, so pressing Delete after marking in/out — without the range being *selected* — does nothing and gives no feedback. If the intent is "cut what I just marked", that is a different action from "cut what is selected".
- **Focus in a text field swallows it.** `onKeyDown` bails when the target is an `input`/`textarea`/`select`, so Delete pressed after typing in a chapter title never reaches the editor. Correct for typing; surprising if focus is somewhere the user has forgotten about.
- **Delete is not a conventional Cut binding.** `⌘/Ctrl + X` is what a user reaches for, and it is unbound.

**Wanted.** Decide between adding `⌘/Ctrl + X` as an alias, making the shortcut act on the marked range when nothing is selected, or simply surfacing the existing binding better (the `?` help sheet is already there). Whatever is chosen, the help sheet and the button tooltip both have to say the same thing — they are the only places the binding is written down.


**Done, and it was the third of the three possibilities.** Not "it needs a selection": marking a range calls `setSelection` on the new segment, so Delete works immediately after, and the button already says "Select a range on the timeline to cut it" when nothing is selected. Not the typing guard either — Delete inside a chapter title should edit the title. It was that `⌘/Ctrl + X`, the binding anyone reaches for, was unbound, so a shortcut that exists felt like one that does not. Bound to the same `deleteSelected` the button calls, below the typing guard so ⌘X in a field still cuts the word. Both places the binding is written down — the Cut tooltip in each of its two render sites, and the `?` help sheet — say so.
---

## 26. No way to cancel a session before the encode starts — and "Cancel encoding" lied during `encrypting` — done

All three parts fixed. The API was always right; every fault was in the UI.

**A way out before the encode.** The discard now appears for `created`, `uploading`, `uploaded`, `queued` and `encoding` — exactly the set `DELETE /api/sessions/:id` accepts, listed as `DISCARDABLE_STATUSES` in `SessionView.vue` with the reason next to it. The label reads "Discard session" until there is an encode to cancel, then "Cancel encoding": the same action, named for what it actually does at that moment.

**It no longer lies in `encrypting`.** The button is gone from the one status the API refuses, and `onCancelEncode` surfaces a refusal instead of swallowing it as "best-effort cleanup" and routing to `/sessions` regardless. The poller restarts when the delete fails, because the session is still running and the view has to keep saying so.

**The stale Swagger** on `deleteSession` now names the set it accepts — the terminal two included, since that is the only way their disk is reclaimed — and the two it refuses, `encrypting` and `uploading_to_s3`, with why.

**Two things the item did not know.**

- **The `encrypting` condition existed in two places.** `SessionWorkflowPanel.vue` carried its own copy of the same three-status test, so fixing only the line the item named would have left the lie intact on the other panel.
- **Placement mattered more than the condition.** The first attempt put the button where the old one lived, in `SessionPlayerStrip`'s `#aside` slot — but that slot only exists once there is a player, and there is no player until a file has been picked. It would have satisfied the status list while leaving `created`, the state the item actually complains about, with no affordance at all. It sits on `session-topline` now, which renders for every status, beside Start Encoding.

10 tests in `SessionView.spec.ts` (app 194 → 204), covering the accepted set, the refused set, the label, the surfaced refusal and the successful path. Confirmed against the original faults re-introduced: six fail, including both halves of the lie.

**Not yet seen in the running app** — the tests assert the wiring, not how the topline looks with another button on it.

---

## 27. Long unexplained gap between "100%" and the session finishing — done

All three parts answered, and then the measurement was acted on: the silence is fixed, the duration was measured, the player-reload question turns out to have been settled already — and the 115 seconds the measurement found have since been removed rather than merely explained.

**It says what it is doing.** `PipelineProgress` gains a `phase`, reported as each post-drain step begins. The client renders it under the Encoding bar: "Packing segments…", "Generating thumbnails…", and so on. An unrecognised phase renders nothing, so an older client against a newer API degrades quietly rather than printing a raw identifier. Carried on `pipelineProgress` rather than as new statuses, as this item suggested: these are not states a session can be resumed or cancelled in, they are commentary on the one it is already in. One phase, `uploading-playlists`, deliberately outlives `encoding` — it captions the S3 bar as that bar restarts from 0 for the playlists and sprites, which are a different set of files from the segments it was counting until then.

Each phase is also timed into the log, because a measurement nobody can repeat is worth little — the answer depends on the source, the machine, and whether the sprite pass had a concat file to work from.

**Measured, on a 20-minute 1080p source, Apple Silicon with VideoToolbox:**

| Phase | Time |
|---|---|
| draining | 1.7 s |
| **thumbnails** | **114.7 s** |
| waveform | 0.0 s (served from the cache primed at ingest) |
| encrypting-playlists | not run — session unencrypted |

The encode itself took 125 s, from 19:29:43 to 19:31:48; the silent stretch ran to 19:33:43. **So the wait was as long as the encode, and it was entirely the sprite pass.** Roughly six minutes on an hour-long source. The waveform and the drain are free, and this item's guess that thumbnails were the suspect was right.

**Measuring found the instrumentation's own gap.** `pipeline.drain()` runs before the first phase was reported, so the earliest part of the stretch was unaccounted for. It is now reported as `draining` — 1.7 s here, but it is the step that rewrites byte-range playlists and can still be uploading, so it is not free by construction.

**The player reload needs no change, and the reason is already written down.** `activePlaybackUrl` deliberately holds at "delivered output or nothing" once completed, and the comment there explains why reaching earlier is wrong: before completion the key may not be settled, so switching at encode start would either play a stream the client cannot decrypt or fall back to the preview indefinitely — "the wrong renditions, transcoding on this machine for as long as anyone watches". The reload was never the wait; the 115 seconds in front of it were.

### Then the 115 seconds were removed

Two separate faults, both in the storyboard pass.

**It was 24× slower than it had any right to be.** On a 4.3 GB, 55-minute, 7-angle source the pass took 337 s with `-hwaccel` against 13.9 s in software, for byte-identical output. The cause was decode acceleration with no `-hwaccel_output_format`: every frame was decoded on the GPU and read straight back to system memory for a software filter chain, at roughly 2 ms a frame. Worse, VideoToolbox logged a per-frame decode failure and still exited 0, so the software-retry guard that exists for exactly this never fired — the fast path was only ever reached by accident, when the GPU failed hard enough to set an exit code. Decode acceleration is gone from the storyboard pass on every platform, CUDA included: that path was never measured, has never been run on a built Windows machine, and is the same silent-failure class.

**And it should not have been running twice.** Untrimmed, the post-encode pass duplicated the ingest-time storyboard prime exactly — same input, same filter — and then deleted the primed copy. That is replaced by sampling once and packing later: ingest writes individual `thumb_%06d` images, and at encode time a selection of them is packed into 5×5 sprite sheets and an output-timeline VTT **with no video decode at all**. The selection is trim-aware, and the chosen index is clamped into the kept range it falls in, so a cue just after a cut-in can never show a frame from material that was cut out. What lands in S3 is unchanged: real sprite sheets with `#xywh` cues, so the player contract and the delivered layout are untouched.

The frames are also sampled from the best-suited angle now — the smallest track at least 320 px wide — rather than ffmpeg's default pick, which on a multi-angle file landed on the 144p proxy and made the filmstrip unreadable.

**`uploadRemainingFiles` was fixed on the way past**: it deduplicates the `init.mp4` files already uploaded during the pipeline (they were being sent twice and listed twice in `files`), uploads with bounded concurrency instead of one at a time, and reports per-file progress.

This closes **item 34**, which proposed overlapping the sprite pass with the encode. Not needed: there is no longer a pass to overlap.

**Two related fixes to the trim filmstrip** came out of the same work, both of which the storyboard's new push-based progress exposed. A storyboard requested while ingest was still running answered 404, which the client latched as "this source will never have one", leaving the timeline frameless for the whole configure phase; it now answers "not yet", and 404 is kept for the one permanent case. And `handleStatusAfterLoad` never started the poller for a session loaded at `uploaded`, so a page opened or reloaded during the configure phase had no event stream at all.

---

## 28. Fullscreen crops the video instead of letterboxing it — done

Fixed where the rule was, in `SessionPlayerStrip.vue`, not in the library: `cover` still applies in the 16/9 strip, and `:fullscreen` / `.lmp-is-fullscreen` now override it to `contain`. No consumer of `player-web` is affected, because the crop was never the player's.

**Not yet seen.** The selector is the one this item diagnosed, but nobody has watched a 4:3 source letterbox in an actual fullscreen since the change.

**Left open deliberately:** whether `cover` belongs in the strip at all. It still silently crops a 4:3 or vertical source in the one view a user checks framing in. Changing that alters what every existing session looks like in the editor, which is a call to make on its own rather than inside a fullscreen fix.

**Cause found.** `player-web`'s own `.lmp-video` rule (`player-web/src/styles.css`, line 38) sets no `object-fit`, so it letterboxes as the UA stylesheet intends. The crop comes from the app: `app/src/components/session-view/SessionPlayerStrip.vue` line 510 sets `object-fit: cover` on `.lmp-video` through a `:deep()` selector.

That is defensible where it was written — `.session-trim-player-shell` forces a `16 / 9` box, and `cover` keeps a non-16:9 source from letterboxing inside the strip. But entering fullscreen does not move the element out of that shell, so the `:deep()` rule still matches, and now `cover` is filling a screen-shaped box with a differently-shaped video. Everything outside the overlap is cropped away.

**Wanted.** Fullscreen must letterbox — `object-fit: contain`, which is the whole point of a fullscreen view. Confining the `cover` to the non-fullscreen case is enough: `.lmp-root` gains `.lmp-is-fullscreen` and matches `:fullscreen`, so either can carry the override.

**Worth deciding at the same time** whether `cover` is right even in the strip. It silently crops a 4:3 or vertical source in the one view a user checks their framing in, which is a poor thing to discover after the encode. `contain` on a 16/9 shell would pillarbox instead — visibly honest, and arguably what that view should show.

---

## 29. Remove the language menu from the fullscreen player — done as configurable; the encoder does not opt out

Built as this item asks: `PlayerControlsOptions.audioMenu`, reaching the component through a sparse `controls` prop on `LuminaryPlayer`, defaulting to today's behaviour so no consumer is affected.

**The "worth checking first" check, run.** The two menus can never be on screen together. `FullscreenControls` mounts only when `isFullscreen && mode === 'element'`, so its audio menu exists *only* in fullscreen; the encoder's Angle / Audio / Quality selectors are a sibling `<div>` below the player shell, outside `<LuminaryPlayer>`, and are neither visible nor reachable there. They are complementary, not duplicated — so opting out would remove the only language switch a viewer can reach in fullscreen and tidy nothing visible. The encoder therefore stays on the default, which is the outcome this item's own last paragraph anticipated.

`{ audioMenu: false }` remains available for a host that genuinely wants it.

**Today.** `player-web/src/components/FullscreenControls.vue` renders an audio-track `<select>` (line 192, `showAudioMenu` — shown when there is more than one track) alongside a subtitles menu. The encoder's own audio selector already sits beside the player outside fullscreen, so in this app the fullscreen one is a duplicate.

**The catch: `player-web` is a published library, not this app's private UI.** A Luminary consumer app has no selectors of its own beside the player — the fullscreen controls *are* its whole surface, and a viewer of a multi-language video needs to choose a language there. Deleting the menu outright would take that away from every consumer to tidy one screen in the encoder.

**So make it configurable rather than removing it.** `LuminaryPlayer` currently takes only `source`, `messages` and an internal test seam, so this means a new prop — something like `hideFullscreenAudioMenu`, or a more general "which fullscreen controls to show" option, defaulting to today's behaviour so consumers are unaffected. The encoder then opts out.

**Worth checking first**, though: in fullscreen the encoder's own selectors are not reachable either, so removing the menu leaves a user mid-video with no way to switch language until they exit. If that is acceptable it is a deliberate trade, not a detail — and if it is not, the answer may be to keep the menu and drop the duplicate outside instead.

---

## 30. Redesign the fullscreen controls, and add skip buttons — done

- **Skip buttons** flank play/pause, 15 s by default, each interval configurable through the `controls` prop item 29 opened. An interval of `0` removes that button rather than leaving one that moves nowhere. The glyph is a ring with the interval inside it, so the control says how far it goes and not only which way.
- **Clamped at both ends.** `seek()` is absolute, so a skip is a computed position. The forward end stops `END_GUARD_S` (0.25 s) short of `duration`: landing exactly on it fires `ended`, so a viewer skipping near the close got "finished" when they asked for "a bit further on". An unknown duration leaves the far end open.
- **Labels interpolate.** `skipBack` / `skipForward` carry a `{seconds}` token filled by `formatSeconds()`, so a configured 10 does not read "15", and a translator can move the number to where their language wants it.
- **Visual pass on the `<select>`s**, which this item named as the weakest part: a pill matching the icon buttons, an inlined chevron (`::after` does not render on a select), a 32px hit area instead of 26, and explicit `option` colours, since the platform draws that dropdown and inherits none of the styling.

12 new tests in `player-web` (60 → 72), covering both intervals, both clamps, the unknown-duration case, removal at `0`, label interpolation, and the audio-menu option.

Seeing the new transport on a phone belongs to item 10, which already carries the untested-on-a-real-device caveat for this surface; it is recorded there rather than holding this item open.

**Today.** `player-web/src/components/FullscreenControls.vue` has an exit button top-left, a single play/pause in the centre, and a bottom bar of elapsed time, scrubber, remaining time and two bare `<select>` menus. There is no way to jump a few seconds — the only seek is dragging the scrubber, which is the least precise gesture available and the hardest one on a phone.

**Wanted.**

- Skip back / skip forward buttons flanking play/pause, default 15 s, with the interval configurable.
- A visual pass over the whole surface. The native `<select>` elements are the weakest part — they are the one place the controls stop looking like a player.

**Notes on the skip interval.** `PlayerController.seek(seconds)` is absolute, so the buttons compute `currentTime ± n` and clamp at both ends — past `duration` is what causes an accidental "video ended". Back and forward are worth allowing separate values: 15 back / 30 forward is a common pairing. The number belongs in the same configuration route item 29 opens (`LuminaryPlayer` takes only `source`, `messages` and a test seam today), so do the two together rather than adding two prop mechanisms a week apart. The button labels need entries in `PlayerMessages`, and they have to interpolate the interval — a hardcoded "15" in a string is wrong the moment someone configures 10.

**Scope note.** This is `player-web`'s surface, which every consumer inherits — so it is a redesign of the library's default player, not of the encoder's. That is the right place for it, but it means the bar is "good enough for Luminary's viewers", not just "looks better in the encoder". Item 10's untested-on-a-real-device caveat applies here too: these controls have only ever run in jsdom and on a desktop, and skip buttons are a touch-target question before they are a visual one.

---

## 31. Scrub thumbnails in the player — done

Makes actionable the "no scrub preview" note recorded under item 10.

**Today.** The encoder generates `thumbnails.vtt` and its sprite sheets and writes them beside `master.m3u8`, and the trim filmstrip already reads them. The player reads neither: `player-core`'s `PlayerSource` has no thumbnail input at all, so there is nothing for `player-web` to draw.

**Wanted.**

- **Fullscreen** — a preview following the scrubber while dragging, which is the point of having sprites at all.
- **Windowed** — the same preview as an *optional* overlay, bottom-centre of the video frame. Optional matters here: outside fullscreen the player deliberately draws no chrome over the picture, so this has to be off by default and asked for, or it breaks that rule for every consumer.

**Most of the parsing already exists.** `segment-editor/src/thumbnailVtt.ts` exports `parseThumbnailVtt`, `findThumbnailCue` and a `ThumbnailSpriteCue` type, and handles the `#xywh=` crop fragment. The cleanest route is moving that into a shared place both can use rather than a second copy in `player-web` — `hls/` is the library both sides already depend on.

**Two things that will bite.**

- **Encrypted sessions encrypt the VTT.** Since #162 an encrypted session LMCENC-wraps every `.m3u8` and `.vtt`, `thumbnails.vtt` included, so the player has to decrypt it with the session key exactly as the app's `useStoryboardVttUrl` does. The sprite *images* are not encrypted (they are `.jpg`), which is worth confirming rather than assuming.
- **Discovery.** Nothing tells a player where `thumbnails.vtt` is; it is a sidecar convention, not a playlist reference. Either `PlayerSource` gains an explicit URL (simplest, and consistent with how `keyHex` is supplied) or the player derives it from the master's prefix — in which case a missing file must be a silent no-op, since `thumbnails: false` sessions and audio-only encodes never have one.

**Do this after item 30**, which reworks the same scrubber.


**Done.** The parse moved to `hls/src/thumbnail-vtt.ts`, which is where the item pointed: two unrelated consumers needed exactly it — the encoder's trim filmstrip and now the player — and `thumbnails.vtt` is a format neither library defines. `segment-editor` keeps its published surface by re-exporting, so nothing downstream changed, and it gained a dependency on `hls` (pure TS, no runtime deps) to do so. The lookup became a binary search on the way: a scrub asks per pointer move, and a two-hour source has thousands of cues.

**Discovery is explicit.** `PlayerSource.sidecars.thumbnails` takes a URL, the way `keyHex` does, rather than the player deriving it from the master's prefix — an audio-only encode and a `thumbnails: false` session have none, and a player that guessed would be requesting a 404 on every load to find that out. The app passes the key the API already reports (`thumbnailsVtt`), resolved against the bucket root, which is the distinction item 12 turned on.

**Encryption came free.** `loadThumbnails` goes through the same `fetchMaybeEncrypted` as chapters, so an LMCENC-wrapped VTT is decrypted with the session key. Confirmed by test rather than assumed. The sprite *images* are ordinary JPEGs and stay that way — the browser fetches them as image sources.

**Every way there can be no preview collapses to one answer.** No sidecar, a 404, an audio-only encode, a VTT that will not parse: all of them are an empty cue list and `thumbnailsReady: false`, because none is something a viewer can act on and all mean the same thing on screen. Nothing is reported as an error.

**Fullscreen** follows the pointer over the scrub area rather than the playhead — while dragging, what a viewer wants is where they are about to land; the video is already showing where they are. Driven from `pointermove` on the wrapper, which covers a hovering mouse and a dragging finger alike.

**Windowed is opt-in and host-driven**, which the item was right to insist on: outside fullscreen this player draws no chrome over the picture, and that is the rule the encoder relies on to put its controls beside the frame. There is also no windowed scrubber to hover. So `LuminaryPlayer` takes `previewTime` — a host with its own timeline says where the pointer is and the player draws the frame bottom-centre. Unset draws nothing. Not wired in the encoder: the trim timeline already has its own filmstrip, so a second preview over the video would be redundant there.

**Two edges worth knowing.** Cue ranges are end-exclusive, so a drag to the far right of the bar matched nothing and the preview blinked out at the position a viewer is most likely to hold — both surfaces now nudge the *lookup* 1 ms back while the label keeps the true time. And a load that fails before its sidecars used to leave the previous video's frames available to `thumbnailAt`, so the cue list is cleared when a load starts rather than only when the next set arrives.

Not done: the frame sizes are fixed (168 px in fullscreen, 176 px windowed) rather than scaling with the viewport, and there is no preloading of the *next* sheet — dragging across a sheet boundary fetches mid-drag. Both are worth measuring on a real device before tuning, which belongs with item 10's device pass.
---

## 32. The scrubber shows what has played and what has loaded, and carries the track menus — done

Beyond items 29 and 30, and worth recording as its own item because of that: this came from reference screenshots rather than from the plan, and it is the piece that touches `player-core`.

**What it was.** The bar was a flat track with a handle on it. Nothing showed how much had played except where the handle sat, nothing showed what had been downloaded, the two readouts were the dimmest text on the surface, and the two `<select>` menus occupied a full-width row of their own to hold two controls at one end of it.

**What it is now.**

- **Three bands** — played, loaded, remainder — each a pill with rounded caps, drawn largest to smallest so every cap stays visible. Not the input's own pseudo-elements: WebKit exposes nothing for the value region, neither engine exposes anything for buffered, and none of them takes a cap independent of the track. So they are plain elements with the `<input>` over them at full size, keeping the drag, the keyboard and the accessible name.
- **Bands are measured against the handle's travel**, not a raw percentage. An input insets its thumb by half its width at each end, so the handle covers `100% - thumb`; measuring against the full width leaves it ahead of the fill through the first half of the video and behind it through the second, meeting only at the midpoint.
- **The far readout is the whole length, not what is left.** It is a fixed point to read progress against. Both readouts take their shape from the duration, so an hour-long video reads `0:08:03` at both ends and the elapsed figure does not gain a field and shift the layout as it crosses the hour. Both are now full white and larger — they are the one thing on the bar a viewer reads rather than operates.
- **The handle appears on approach** — hover, focus or drag — and is absent at rest, where the bar is a readout rather than a control. Instant under `prefers-reduced-motion`.
- **The menus moved onto the scrubber row**, and the bar lifted clear of the bottom edge, which on a phone is where the home indicator and the edge-swipe gesture live.

**The `player-core` part.** `PlayerState` gains `bufferedEnd`, fed by a new `progress` adapter event. Additive on purpose: an adapter that cannot report it never emits, and the band never draws — which is what the AVPlayer and ExoPlayer adapters will need. `HlsJsAdapter` reports the end of the range **containing the playhead**, not the furthest range held: after a seek there is often media well ahead with a gap between, and drawing that as one band promises a smooth run into a stall. Playhead in a gap reports nought. It emits on `timeupdate` as well as `progress`, because `progress` fires on network activity and the band would otherwise sit still while the playhead ran through what was already loaded.

7 new tests in `player-web` (72 → 79): three on the adapter's gap handling, four on the readouts and band sizing including the behind-the-playhead and unknown-duration cases.

**Unseen on a device**, like the rest of this surface — see item 10.

---

## 33. Packaging ships whatever is in `app/dist`, including a developer's `.env`

**Found while checking that item 24's dev defaults could not reach a build.** They cannot — but something else can.

**Today.** `dist:mac` is `npm run fetch-binaries && npm run build && electron-builder`. That middle step is `tsc -p tsconfig.json`, which compiles *Electron's own* TypeScript; nothing in the packaging chain builds the web client. `electron-builder.yml` then copies `../app/dist` into the installer as-is. So a release ships whatever happens to be sitting in that directory — the last build anyone ran, with whatever `.env` they had at the time.

Vite bakes `VITE_*` values into the bundle, so right now `app/dist` carries `VITE_API_TOKEN=dev-token` and `VITE_API_URL=http://127.0.0.1:31711` from a developer machine.

**Not a security hole.** The packaged renderer takes its token from the preload bridge before it ever reads the baked value, and the host mints a fresh one per launch that would not match `dev-token` regardless. The shipped string is dead.

**But two real failures follow from it.**

- `VITE_API_URL` is baked as an *absolute* URL, while the packaged app is meant to be same-origin — the API serves the client. `31711` happens to be the Electron default, so today it works by luck. Ship while a developer's `.env` says `:3000`, as it did during item 24's work, and the packaged app points at nothing.
- `app/dist` is gitignored, so on a clean machine it does not exist. Packaging there produces an installer with no web client at all, and `bundledWebClient()` has nothing to serve.

**Wanted.** `dist:mac` / `dist:win` / `pack` should build the client themselves, with an environment that cannot inherit a developer's `.env` — the packaged app wants `VITE_API_URL` empty, which is what same-origin means. Worth proving by running `pack` afterwards and confirming the result contains a client and no absolute API URL.

**Interacts with item 5** (Windows build verification) and with item 24, whose `.env.example` should say plainly that `VITE_API_URL` must be empty for anything that will be packaged.

### Done — and the leak was in the app, not the build script

**The `.env` no longer reaches a build at all, whoever runs it.** The write-up above assumed the fix belonged in the packaging chain — scrub the environment before building the client. It belonged in the client. `API_BASE` read

```ts
import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:3000' : '')
```

and the comment above it claimed `DEV` kept this out of a build. It did not: `??` only falls through when the variable is *undefined*, and Vite bakes every `VITE_*` value into every bundle. So the dev branch was guarded and the shipped branch was not. Reading the variable **inside** the `DEV` branch instead means no `.env` on any machine can reach a build however it is invoked — including a colleague running `npm -w app run build` by hand, which no packaging script could have protected. `VITE_API_TOKEN` had the same shape in `auth-token.ts` and got the same treatment; it was never exploitable (the bridge answers first, and the host's per-launch token would not match a baked one) but a credential in a release artifact should not depend on being unreachable to be harmless.

Verified by building with a deliberately hostile `app/.env` (`VITE_API_URL=http://127.0.0.1:9999`, `VITE_API_TOKEN=leakme-poison-token`) and grepping the output: absent, along with `31711`, `dev-token` and `3000`. `API_BASE` compiles to `""` and the dev branch is tree-shaken away entirely. The prior `app/dist` on this machine did contain `127.0.0.1:31711` and `dev-token`, so the leak was real and not theoretical.

**Regression tests, and why the old ones missed it.** `api-base.spec.ts` already asserted "stays same-origin in a build" — but only with nothing configured, which passed either way. The case that mattered, `DEV: false` *with* `VITE_API_URL` set, was never written. That case and its token equivalent are now covered, and both were confirmed to fail against the old code before the fix went back in.

**Packaging now builds what it ships.** `dist:mac` / `dist:win` / `pack` run `build:workspaces` first, which calls the root's new `build:bundled` — the five shared libraries, then the API, then the web client. Root also gained `build:libs`, which `predev` and `predev:electron` now share instead of repeating the list.

**A third staleness bug the item did not name:** `api/dist` was never built by the packaging chain either. `npm run build` in `electron/` is `tsc -p tsconfig.json`, which compiles only Electron's own TypeScript, so packaging on a clean machine would have produced an installer whose *bundled API* was missing or stale — not merely its client. Covered by the same fix.

Proven end to end: `app/dist`, `api/dist` and `electron/dist` were all deleted to simulate a clean clone, then `npm -w electron run pack` rebuilt all three and produced a package containing `index.html` plus four JS assets, `ffmpeg`/`ffprobe`, and `@luminary-media-converter/api/dist/{bootstrap,main,app.module}.js` inside `app.asar` — with none of `31711`, `dev-token` or `3000` anywhere in the packaged client, despite the real `.env` on this machine setting the first two.

`app/.env.example` now states that both variables are development-only and that nothing in the file can reach a build, rather than asking the reader to remember to blank one before packaging.

**Not done:** the packaged app was not launched afterwards. `pack` output was inspected, not run — booting it is item 5a's territory (bundled-ffmpeg verification), and unrelated to what changed here.

---

## 34. Thumbnail sprites could run alongside the encode, not after it — done, by removing the pass instead

**Superseded by the work in item 27.** This proposed overlapping the 114.7 s sprite pass with the encode, since it reads the *source* file and so has no data dependency on the encode's output. That reasoning was right, and it is now moot: the pass no longer exists.

Sampling happens once, at ingest, into individual `thumb_%06d` frames the trim timeline is already waiting for. What runs at encode time packs a selection of those frames into sprite sheets and decodes no video at all, so there is nothing left to overlap. The concat-file wrinkle this item worried about — `concat.txt` being written *during* the encode by `FfmpegService`, so an overlapping pass could not see it — disappears with it: a trimmed session selects frames by mapping output time back through the kept ranges, which needs no concat file.

The one caveat this item raised that did survive: sprites must exist before `pipeline.uploadRemainingFiles(outputDir)` sweeps the directory, and they do — the pack is awaited exactly where the old pass was.

---

## 35. A missing ffmpeg is reported as a working CPU-only install — fixed

**Found while proving out item 33's packaging changes**, by packing with the bundled binaries parked and launching the result with `PATH=/usr/bin:/bin` — no ffmpeg bundled, none on the system.

**Today.** The app starts cleanly, serves the UI, answers `/api/cms/health`, and logs:

```
[FfmpegService] No GPU found, using CPU encoding
[FfmpegService] FFmpeg threads: 8
```

Which reads as *this will work, just slowly*. Nothing will work. `detectAcceleration()` calls `detectNvidiaGpu()` then `detectAppleGpu()`, and each wraps its probes in `try { execSync(...) } catch { return false }` — so `ENOENT` from a binary that is not there is indistinguishable from an ffmpeg that simply has no NVENC. Both fall through to `'cpu'`, and `'cpu'` is reported as a capability rather than as a guess. The user finds out when they pick a file and start an encode, by which point they have chosen a destination in the CMS and waited for a probe.

**Wanted.** A presence check separate from the capability check — run `ffmpeg -version` and `ffprobe -version` once at startup and distinguish three states, not two: *missing*, *present without hardware acceleration*, *present with*. Missing should be surfaced to the renderer as a first-class condition, not left for the first encode to discover. `bootstrap.ts` already reports `encoder` on every status response, so the shape for carrying it exists.

**Worth noting the failure is silent at both ends.** Packaging does not complain when the binaries are absent (item 5a), and the app does not complain when they are missing at runtime. Either check on its own would have caught the pair.

**Blocks nothing today** — every shipped path bundles the binaries, and `dist:mac` / `dist:win` fetch them. It matters the moment either changes, which is item 36.

### Done — presence is now its own question, and FFmpeg is a hard requirement

`ffmpeg-availability.ts` runs `ffmpeg -version` and `ffprobe -version` and reports three states rather than two: missing, present, present-with-a-version. It is separate from `detectAcceleration()` on purpose — that answers capability, and answering only capability was the bug. Re-exported from `bootstrap.ts` so the Electron host reaches the verdict the way the API does; two independent checks would eventually disagree, and the one the user sees is the host's while the one refusing their encode is the API's.

Three behaviours came out of it:

- **The startup log tells the truth.** `FFmpeg 8.1, ffprobe 8.1` when present; an `ERROR` naming what is missing, where it was looked for and where to get it when not. The version is logged because version skew is a support cost and the first question will be "which ffmpeg".
- **The host refuses to open a window without it** (`encoderPresent()` in `electron/src/main.ts`). Per Johan, FFmpeg is mandatory, so the dialog offers **Get FFmpeg** / **Quit** — an earlier draft offered "Continue without it", which he rightly rejected as an option that only defers the same failure. The server is closed before exiting rather than quitting out from under Nest.
- **The API refuses work needing it** with `503` and the same text, at both ingest and encode start. Ingest matters most: attaching a source probes it immediately, so a missing install used to surface as a failed probe — which reads as a problem with the user's file. Checked at encode too, since a session can sit in `uploaded` across an uninstall.

Verified by packing with the binaries parked and launching with `PATH=/usr/bin:/bin`: the dialog appears with the reason and the download link, and the process waits on it rather than opening a window. Then re-verified the other direction — binaries restored, same scrubbed PATH — and the app logs `FFmpeg 8.1`, detects VideoToolbox, serves the client and shuts down cleanly.

One flaw found in this work and worth remembering: the first draft called the check as `void warnIfEncoderMissing()`. The reason was logged and no dialog ever appeared, which is indistinguishable from a dialog the user dismissed — a floating promise had swallowed the rejection. Confirmed by screenshot both before and after, because "it should show a dialog" is not evidence that one did.

**Open, and raised by Johan while this landed: there is no minimum version check.** See item 37.

---

## 36. Decision: keep bundling ffmpeg, or ask the user to install it? — decided

**Raised by Ivan (11 Aug 2026):** if a user does not have ffmpeg, we could ask them to install it rather than embedding it in the Electron app.

**The case for it is real.** The `.dmg` is 146 MB, almost all of it ffmpeg. Shipping a GPL build also carries obligations that `electron/bin/README.md` sets out, and which someone at BCC has to own before a public release. Not bundling makes both of those go away.

**What it would cost, measured rather than guessed** (see item 35 for the runs):

- **There is no "ffmpeg not found" path at all.** Today a machine without it is told "No GPU found, using CPU encoding" and fails later, mid-session. Item 35 is the prerequisite, not an optional polish.
- **A user's own build is a lottery.** Hardware encoding is a compile-time decision. macOS has Homebrew, but its ffmpeg links eighteen dylibs under `/opt/homebrew` (5a) and is Intel-only from evermeet.cx; on Windows most published builds lack NVENC. The difference is not cosmetic: a 20-minute 1080p source encoded in 125 s on VideoToolbox (item 27), and CPU is several times that on the same hardware.
- **Version skew becomes ours to support.** The pipeline passes `scale_vt`, `-hls_fmp4_init_filename`, `-movflags +negative_cts_offsets+default_base_moof`, `-var_stream_map`. An older distro ffmpeg fails on these in ways no one here can reproduce, from a machine we cannot inspect.
- **The audience is CMS editors, not developers.** "Install ffmpeg and put it on your PATH" is a support ticket per user on Windows, and the person answering it is us.

**A third option worth putting to Ivan:** keep controlling *which* build is used, but stop shipping it inside the installer — fetch the same pinned, digest-checked binary on first run, which `fetch-binaries` already does at build time. That drops the installer to a few megabytes and puts the ffmpeg download outside our distribution, while leaving no room for a user's own build to vary. It needs a first-run UI, a failure path for no network, and a decision about where the binaries live on disk.

### Decided (Johan, 12 Aug 2026): FFmpeg is mandatory, and the app checks for it

Two rules, both built:

- **Absent** → the app says so and offers the download, rather than opening a window in which nothing can be done (item 35).
- **Present but too old** → refused with the version to install, decided by asking the binary what it supports rather than by comparing version strings (item 37, floor 4.4).

So the "ask the user" half of this question is answered and shipped. What that leaves is narrower than the item's title suggests, and worth stating plainly because it is the half with the money in it: **the packaged build still carries its own binaries** — `dist:mac` and `dist:win` run `fetch-binaries`, and `electron-builder.yml` copies them into the app. The prompt is a fallback for a machine that somehow has none (a run from source, or a `pack` build, which skips the fetch), not a replacement for shipping them.

That is a coherent place to stand: a user who installs the app gets a known-good build with the right hardware encoders, and a developer running from source gets told what to install. It also means the two costs the item opened with are unchanged — a 146 MB `.dmg`, and the GPL obligations `electron/bin/README.md` sets out.

### And the shipping half: keep the binaries in the installer

Decided together with the above. The reasoning, so it can be revisited on its merits rather than re-argued from scratch:

- **The audience settles it.** These are CMS editors, not developers. "Install FFmpeg and add it to your PATH" is a support ticket per user on Windows — unzip, edit environment variables, restart — and the person answering it is us. An app that works on first launch is worth more than 140 MB of disk.
- **146 MB is unremarkable for this class of tool.** HandBrake, OBS and DaVinci are all in that range or past it. It is a one-time download for something installed deliberately.
- **The prompt is now a fallback doing its proper job**, not a substitute for shipping: it covers a run from source and a package built without the fetch (`pack` skips it). That is the right scope for it.

**The two costs this item opened with do not go away — they get addressed directly:**

- **The GPL obligation is paperwork, not an obstacle.** ffmpeg runs as a separate process and is never linked, so the obligation travels with the binary rather than reaching this Apache-2.0 codebase (item 5a says the same). It needs someone at BCC to sign off the notice and the source offer once. Until that happens, nothing here is publicly distributable — which is a release blocker, not a design one.
- **The size only really bites with auto-update** (item 2), where a naive feed re-downloads ~100 MB per release. `electron-updater` supports differential updates through block maps; that is the thing to get right when item 2 lands, and it is configuration rather than architecture.

**One claim in this item was wrong, and is now checked.** It said "on Windows most published builds lack NVENC". The Windows runner (see item 40) ran `-hwaccels` and `-encoders` against the pinned BtbN build on 12 Aug 2026:

```
hwaccels: cuda  vaapi  dxva2  qsv
encoders: h264_nvenc, hevc_nvenc, av1_nvenc, libx264
filters:  scale_cuda
```

So everything `FfmpegService` looks for on the NVIDIA path is present, plus `libx264` for the CPU fallback. The "build lottery" argument for bundling is therefore weaker than this item claimed — nobody should repeat it. The decision to keep shipping stands, because it rests on the support burden of asking CMS editors to install and PATH a binary, which does not depend on that claim at all.

The genuinely scarce case is a native macOS arm64 build, not Windows: `evermeet.cx` publishes x86_64 only and Homebrew's is not relocatable, which is why the macOS side is on a one-person site in the first place.

**If it is ever revisited**, the third option below is the one to reach for rather than plain "ask the user": keep controlling *which* build is used and fetch the pinned, digest-checked binary on first run. That removes the binary from the installer without handing anyone a build lottery. What this repo can say is that the "ask the user" option is not free today: item 35 has to land first, or the first thing a user without ffmpeg sees is an encode that fails after they have committed to a destination.

### Decided for now (Johan, 11 Aug 2026): FFmpeg is mandatory, and a machine without it is told to install it

Item 35 has since landed, so the prerequisite above is met: a machine without FFmpeg gets a dialog naming what is missing, a **Get FFmpeg** button, and **Quit** — the app does not open a window it cannot do anything in.

What this decision does *not* settle is whether the binaries keep shipping inside the installer. Both remain true at once today: a packaged build carries its own pair, and a machine without them is told to install. That is a reasonable place to sit, but it leaves the 146 MB and the licensing question exactly where they were.

**What the decision does change is the exposure.** A user-supplied FFmpeg is now a supported source rather than a developer convenience, which promotes the "lottery" and "version skew" bullets above from hypothetical to live — and neither is currently guarded. Item 37.

---

## 37. No minimum FFmpeg version is enforced — fixed

**Raised by Johan, 11 Aug 2026**, while item 35 landed: is there a minimum version, and do we check it?

**Today: no.** The startup probe records the version (`FFmpeg 8.1, ffprobe 8.1`) and nothing compares it to anything. That was defensible while every shipped path carried a known-good binary fetched by `fetch-binaries` against a pinned digest. It is not defensible now that item 36 makes a user-supplied install a supported source: the encoder will happily start on an FFmpeg too old for the flags it is about to use, and fail inside a child process partway through an encode — the same class of confusion item 35 just removed from the missing-binary case.

**What the pipeline actually depends on**, which is what a floor has to be derived from rather than guessed:

- `-stats_period` (progress reporting) — the newest of the *unconditional* flags, and therefore probably the binding constraint
- `-var_stream_map`, `-hls_segment_type fmp4`, `-hls_fmp4_init_filename`, `-master_pl_name`
- `-movflags +negative_cts_offsets+default_base_moof`
- `scale_vt` and `h264_videotoolbox`, `scale_cuda` and `h264_nvenc` — these are already capability-probed, so an FFmpeg without them degrades to CPU rather than failing. They do not belong in a version floor; they are the reason a version floor is not sufficient on its own

**Two traps to avoid**, both of which would refuse working installs:

- **Version strings are not semver.** Real builds report `4.4.2-0ubuntu0.22.04.1`, `7.1.1_2` (Homebrew), and `N-113140-gd12b0e6f4b` (nightly, no version number at all). A naive parse-and-compare refuses the nightly, which is newer than any floor we would set.
- **An unparseable version is not an old one.** It should be allowed with a note, not blocked.

**Recommended shape.** A documented floor constant with the reason for the number written beside it, compared only when the version parses; unparseable versions pass with a log line. Below the floor, refuse at startup the way a missing binary now does — a too-old FFmpeg is not a degraded encoder, it is an encoder that will fail somewhere less legible. The capability probes stay as they are: they cover the hardware paths, which no version number can.

**What is missing to do it properly: evidence for the number.** Picking a floor from memory is how a working install gets refused. It wants either a real check of when each flag landed, or — better and cheaper to keep honest — a *capability* probe per unconditional flag, the way the GPU paths are already probed, with the version reported only as context in the message. That way the check tests what the code actually needs rather than a proxy for it.

### Done — the requirement is 4.4, enforced by asking the binary rather than by comparing versions

**The number: FFmpeg 4.4** (April 2021). Established by reading FFmpeg's own source at release tags rather than from memory, which is what the item asked for:

| Option | Evidence |
|---|---|
| `-stats_period` | **absent in `n4.3`, present in `n4.4`** (`fftools/ffmpeg_opt.c`) — the binding constraint |
| `-var_stream_map`, `master_pl_name` | present from `n4.0` (`libavformat/hlsenc.c`); absent in `n3.4` |
| `-hls_segment_type`, `-hls_fmp4_init_filename` | present from `n3.4` |
| `negative_cts_offsets` | present from `n4.0` (`libavformat/movenc.c`) |

**Enforcement does not use that number.** `ffmpeg-capabilities.ts` asks the binary what it supports — `-h muxer=hls`, `-h muxer=mp4`, and for the global option, whether `ffmpeg -stats_period 1` answers `Unrecognized option` (argument parsing happens before the missing-output complaint, so nothing has to be encoded to find out). Three cheap calls, and none of them can be wrong about which release added what. The version is used only to tell the user what to install, which avoids the two traps the item named: distro and Homebrew suffixes, and nightlies with no version number at all that are newer than any floor.

A probe that cannot run reports `indeterminate` and blocks nothing. A failed probe is not evidence of an old build, and refusing on it would turn an unanswerable question into a broken app — the same rule `disk-space.ts` follows for an unreadable free-space figure.

**The message was rewritten after review.** The first version listed every unsupported option in the dialog. Johan's point: the person reading it wants to know that they need a newer FFmpeg and which one, not which muxer option is missing. So the dialog now says *"Luminary Media Convert needs FFmpeg 4.4 or newer — the installed FFmpeg is too old (version 3.4.8)"* with the download link, and the option list goes to the log via `capabilityDetail()`, where the reader is us and "too old" alone would not be diagnosable. Same split for the absent case: the user gets "FFmpeg is not installed", the log gets which of the two binaries could not be run.

**Verified on a packaged build** with `PATH` controlled, in three states — nothing installed, a stub reporting 3.4.8 with 4.4-era options missing, and the real bundled 8.1. The first two produce the dialog and no window; the third starts normally. The too-old case could not have been tested on this machine without a fixture, so the unit tests build fake ffmpeg scripts that answer the probes the way real builds do, including a 4.0-era one that has the HLS options but not `-stats_period` — partial support being the likely real-world case rather than all-or-nothing.

---

## 38. `convertToByteRange` real-worker test is flaky in the full suite — fixed

**Found while verifying item 37**, when the full API suite failed once and the natural suspicion was the new startup probes.

**It is not new.** `ffmpeg.service.spec.ts > convertToByteRange > should reject when worker emits an error (real worker)` times out at ~5 s in a full-suite run and passes every time the file is run alone. Confirmed against the branch point with the item-37 work stashed: 824 passed, the same one failed. Excluding the two new spec files does not help either, so it is neither their load nor the source change.

**Why it matters even though it is not a regression.** It cost time here precisely because it looked like one — and it will do that again to whoever next changes anything near `FfmpegService`. A test that fails only in company is a test nobody can use to answer "did I break this?".

**Likely cause.** The test spawns a *real* worker thread against `/non/existent/dir` and expects a rejection within the default 5 s. Under a parallel suite the worker's own startup is slow enough to lose that race. Worth either giving the assertion a longer timeout, or removing the real-worker dependency the way the sibling tests do (`useRealWorker.value = false` plus an emitted `error`), which is what the rest of that describe block already does.


**Fixed by giving it a timeout that fits what it waits on.** It spawns a real worker thread — the point of it, and the one thing its fake-worker sibling cannot cover — and worker startup routinely lost a race with vitest's 5 s default once a dozen other files were running in parallel, several spawning processes of their own. Nothing about the code under test is slow; the budget was simply too tight to survive a busy machine.

Kept as a real-worker test rather than converted to a fake, because what it proves is that the actual `Worker` wiring reports a failure instead of hanging. Verified with three consecutive full-suite runs, where it had previously failed every time while passing when run alone.

The reason this was worth fixing rather than tolerating: a test that fails only in company is a test nobody can use to answer "did I break this?". It cost an hour of suspecting an unrelated change on the day it was found, and would have cost the next person the same.
---

## 39. Sprite packing failed whenever `WORK_DIR` was relative — fixed

**Found immediately after merging #163 and #167**, by encoding a session on the merged branch and noticing it reported no `thumbnailsVtt` at all — the same flow had reported one an hour earlier.

**What happened.** `packForDelivery` writes an ffconcat list naming the ingest-time thumbnails, and the concat demuxer resolves relative entries against **the list file's own directory**, not the process's working directory. `WORK_DIR` defaults to `./work` when the API runs standalone, so the list at `work/<id>/output/thumbnails/pack-list.txt` held entries like `work/<id>/preview-thumbnails/thumbnails/thumb_000001.jpg`, and ffmpeg looked for the two concatenated:

```
Impossible to open 'work/<id>/output/thumbnails/work/<id>/preview-thumbnails/thumbnails/thumb_000001.jpg'
```

**Why nobody saw it.** It fails as a `WARN` and a session with no sprites — the pass is deliberately non-fatal, which is right. And it cannot happen under Electron, which passes an absolute `workDir`; only the standalone API defaults to a relative one, so it hit exactly `npm run dev` and nothing else. Every existing test in `thumbnail.service.spec.ts` sets an absolute `WORK_DIR` for its temp directory, which is why 77 of them passed over it.

**Fixed** by resolving each entry to an absolute path. Covered by a test that runs with a *relative* `WORK_DIR` from a temporary cwd — confirmed to fail against the unfixed code and pass with it, since a test for this is only meaningful from the configuration that broke.

Verified end to end afterwards: the same encode now logs `Packed 12 thumbnail(s) into 1 sprite sheet(s)`, reports `thumbnailsVtt`, and the sheet answers 200 from S3.

**The same shape exists for trim segments** — `buildConcatFile` in `ffmpeg.service.ts` writes the source path into an ffconcat list the same way. It was safe, but only because `encode.controller.ts` rejects a non-absolute path at ingest: a guarantee made three files away, which is exactly the kind this bug was safe by until it wasn't. Now resolved at the point of use, with a test that hands it a relative path. (An earlier draft of this note named `concat-file.ts`; that file only ever existed in the abandoned item-34 work and is not in the tree.)



---

## 40. Embed FFmpeg so no user ever meets the install prompt — and settle the licence that lets us

**Where this stands today, because it is half-done rather than not started.** A packaged build already carries its own `ffmpeg` and `ffprobe`: `dist:mac` / `dist:win` run `fetch-binaries`, and `electron-builder.yml` copies them in through `extraResources`. `bundledBinary()` prefers them over anything on PATH whenever `app.isPackaged`. Verified: the packaged app was launched with `PATH=/usr/bin:/bin` — no system ffmpeg reachable — and still reported `Apple Silicon detected, using VideoToolbox acceleration`.

So the install prompt (item 35) is a fallback. **Wanted: make that true of every user, on every platform, from every build path** — and as of 12 Aug 2026 the macOS side is there, verified on each route:

| How the app is run | Where FFmpeg comes from | Checked |
|---|---|---|
| Installed (packaged) | `Contents/Resources/` | launched with `PATH=/usr/bin:/bin`, found FFmpeg 8.1 + VideoToolbox |
| From source (`dev:electron`) | `electron/bin/<platform>-<arch>/` | same, same result |
| `pack` on a clean clone | fetched, then packaged | 0 missing-source warnings; app then ran with PATH scrubbed |
| `dist:mac` / `dist:win` | fetched, then packaged | the fetch fails hard rather than shipping without |

**The from-source case is new and was the interesting one.** `bundledBinary()` used to return early when `!app.isPackaged`, reasoning that "a developer running from source has neither, and their own install is the right one". That was true when the repository carried no binaries and wrong once it does — it left the one person able to notice a problem testing against a different FFmpeg from every user. It now resolves `electron/bin/<platform>-<arch>/` in development, so a developer who has run the fetch once gets the shipped build.

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

**Item 36's NVENC claim is settled, and it was false.** `strings` could not settle it — `h264_nvenc` and `scale_cuda` appear in the binary, but so does `videotoolbox`, which cannot work on Windows, so those come from name tables rather than proving compiled-in support. The runner answered it properly: `cuda` in `-hwaccels`, `h264_nvenc` / `hevc_nvenc` / `av1_nvenc` / `libx264` in `-encoders`, `scale_cuda` in `-filters`.

**The runner also earned its keep immediately by finding a Windows-only defect on its first run.** `fs.rename` cannot cross volumes, and there the temp directory is on `C:` while the checkout is on `D:` — `EXDEV`. No macOS run can reproduce that, because everything is one filesystem. Staging now sits inside `electron/bin/` so the move stays on one volume. That is the second Windows-only fault this work has surfaced, after `unzip`, `mv` and `file` not existing there — which is the argument for the runner in one line.

**`dist:win` now runs, and its output installs.** The installer step was gated behind the `package` input, which only `workflow_dispatch` supplies — and that needs the workflow on the default branch. A push to `ci/windows-pack-*` now asks for it too, which produced the first `.exe` (156 MB, unsigned); Johan installed it successfully on a Windows PC on 12 Aug 2026. What the install does *not* establish is that the app launches or encodes there — see item 5.

**The first `dist:win` attempt failed, and the bug was not Windows-specific.** `build:libs` compiled `segment-editor` before `hls`, which it imports from, so `vue-tsc` had no declarations: `TS2307 Cannot find module '@luminary-media-converter/hls'`, and `TS7006` on a callback parameter as a consequence of the unresolved type. Invisible on a development machine, where `hls/dist` is left over from an earlier build. **Any clean clone could not build** — the runner was simply the first thing to try. Order now follows the dependency direction.

### 2. `pack` produced an app with no encoder, silently — fixed

`pack` skipped `fetch-binaries` on the reasoning that a `--dir` smoke test should not pull 100 MB, and electron-builder treats a missing `extraResources` source as a *warning* rather than an error. The result started, served the UI and showed the install prompt: fine for a developer who knew, a trap for anyone handed that directory. It fetches now, like `dist:mac` and `dist:win`, so no packaging path can produce an app without an encoder. Verified by deleting `electron/bin/darwin-arm64/` and packing: it fetched, packaged with zero missing-source warnings, and the resulting app found FFmpeg with `PATH` scrubbed to `/usr/bin:/bin`.

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

1. **Keep the palettes from drifting.** The libraries carry their own tokens, and the app carries Tailwind's. Item 17 found the consequence: the timeline's buttons were blue-950 while the app's were slate, so the timeline read as borrowed from another application. The fix was to set the library's token to the Tailwind value the app uses. Doing that deliberately across the remaining tokens — surfaces, borders, text, danger — is cheap and removes a whole class of "looks like two apps" bugs.
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
