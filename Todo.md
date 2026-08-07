# Todo — follow-up work

Deferred work and known gaps after the local-only Electron migration. Each item states what exists today, what is missing, and where the work lands. Nothing here is a bug report against shipped behaviour; these are things deliberately left for later.

Ordered roughly by value, not by effort.

---

## 0. Handover state (read this first)

**Branch.** All migration work (issue #154) is on `154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features`, open as PR #161. The original seven logical commits (SaaS removal → hls lib → api → app → cms-mock → electron → docs) have since been joined by the manual-verification fixes, the app icon, a merge of `main`, and the restored test suites.

**Build state.** All workspaces build, and all test suites pass: api 795, app 192, segment-editor 217, hls 121, player-core 168, player-web 58 (item 6). `vue-tsc` typechecks the specs again. A packaged macOS `.app` and `.dmg` were built and verified to boot the embedded API, serve the UI, and carry the app icon.

**Player extraction (issue #153, PR #162) has since landed on top of this branch.** Playback logic left the app for two packages — `player-core` (headless: munging, controller, recovery, polling) and `player-web` (hls.js reference implementation) — Video.js is gone, and encryption now covers playlists, chapters and subtitles rather than segments alone. Items below are marked where that work closed or changed them.

**Manual verification — mostly done.** A full pass was run through the Electron app and `cms-mock` against a local MinIO: CMS handshake and idempotency, TOFU origin gating, local-file ingest by reference, probe, trim, encode, SSE with `hlsUrl` + `encryptionKeyHex`, encrypted playback via the `luminary://key` swap, chapters, session delete, and credential recovery across a restart. Several defects were found and fixed in the process (storyboard cue clipping at a trim in-point, trim semantics, timeline duration during an encode, playhead clipping at the ends, waveform contrast on an audio source, storyboard polling on a source with no video track).

Still outstanding:

- [x] Multi-angle source: single `master.m3u8` with `#EXT-X-MEDIA:TYPE=VIDEO` groups in S3; angle switching + audio-only in the app player (client-side extraction). **Verified** against S3 output with #162 — angle, audio-track and quality selection all confirmed working.
- [ ] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the _default angle_ of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls/` helpers depend on this. **Now has a second half:** with #162 an encrypted session also encrypts its playlists (LMCENC), which no stock player can read at all — such a client needs `encryption.encryptPlaylists: false` until it moves to `player-core`. Worth testing both, since the answer decides whether that opt-out is a transitional courtesy or a permanent mode.
- [ ] Queue: three CMS sessions encoding FIFO with SSE `queuePosition` updates.
- [ ] Protocol handler from a packaged install: `open luminary-convert://` launches/focuses the app.
- [ ] Packaged mac build encodes with `encoder: 'apple'` (VideoToolbox) — blocked on item 5a; the packaged app currently falls back to PATH, so it cannot encode on a machine without a system ffmpeg.

---

## 0b. CMS-side integration (bccsa/luminary — out of this repo)

The encoder's half of the contract is done and documented (CLAUDE.md "CMS contract"; `cms-mock/` is the executable reference). The Luminary side still needs, on branch `1878-api-cms-hls-media-data-model` or successor:

- The "upload / edit media" button: health-check `GET /api/cms/health` on `http://127.0.0.1:31711`, `luminary-convert://` launch fallback, then `POST /api/cms/sessions` (Chrome LNA; Chrome-only at time of writing).
- SSE consumer on `eventsUrl`: on the first `encoding` event, save `MediaDto { hlsUrl, hlsKey }` — the post can be saved before encoding completes. **Changed by #162:** the key no longer rides on the event. Fetch it from `GET /api/sessions/:id/key?token=read_…` and unmask it (XOR with `SHA-256(sessionId)[0..16]`, self-inverse); `cms-mock/src/store.ts` (`captureHlsKey`) is the reference. A CMS still reading `encryptionKeyHex` off the frame will silently get `undefined`.
- Player-side: **adopt `@luminary-media-converter/player-web`** (or `player-core` with an adapter) rather than wiring the `hls/` helpers by hand — it already does angle extraction, the `luminary://key` swap from memory, quality capping, chapters, subtitles, recovery, and the "not available yet" state as a `coming-soon` slot that polls until the playlist appears. Since #162 an encrypted session also encrypts its playlists and VTTs, which only these packages can read.
- Passing `existingMedia { hlsUrl, hlsKey }` for edit mode once item 1 lands (the DTO already accepts it).

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

## 5. Windows build verification

**Today.** `electron-builder.yml` has a `win` / `nsis` target (x64, non-one-click, per-user, installation directory changeable) and the protocol registration is written to cover Windows. **It has never been built or run.**

**Needed.**

- A Windows machine (or CI runner) to build on
- NVENC-capable `ffmpeg.exe` / `ffprobe.exe` in `electron/bin/win32-x64/` — see `electron/bin/README.md` for sources (gyan.dev, BtbN) and verification (`ffmpeg -hwaccels`, `ffmpeg -encoders | findstr nvenc`)
- Verification of the things that differ from macOS: `luminary-convert://` protocol registration through the installer, `safeStorage` (DPAPI-backed, should be fine), the `resourcesPath` binary lookup with `.exe` suffixes, path handling with spaces (`shellQuote` covers the `execSync` probes; `execFile` callers are unaffected), and whether Windows Defender / SmartScreen blocks an unsigned installer outright
- Confirm the NVIDIA acceleration path end-to-end, which no developer machine in this project can currently exercise

---

## 5a. Bundle ffmpeg/ffprobe binaries — done for macOS

`npm -w electron run fetch-binaries` downloads the pair, checks a pinned SHA-256, verifies the architecture and the encoders the app actually asks for, and writes the GPL licence text beside them. `dist:mac` and `dist:win` depend on it, so a build can no longer quietly produce an app with no encoder in it.

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

**No scrub preview in the fullscreen scrubber.** `thumbnails.vtt` and its sprite sheets are generated and sit beside the master, and the encoder's trim filmstrip already reads them — the player does not. Wiring the existing sprites into `player-web`'s scrubber would give previews on web and Android with no encoder change, and the VTT parser exists.

That is worth settling before reaching for **I-frame playlists** (`#EXT-X-I-FRAME-STREAM-INF`), which are tempting because they are the HLS-native answer and turn out not to be portable: AVPlayer uses them, ExoPlayer ignores them, hls.js gives no preview UI either way. They earn their keep in exactly one case — deferring to Apple's built-in player chrome in a Capacitor app — and cost an extra extraction pass at encode time, since FFmpeg's HLS muxer cannot emit them. Wherever we draw the controls ourselves, a sprite sheet is one image and one crop. The lossless parser already round-trips the tag, so adding them later disturbs nothing.

**`waveform.json` is not encrypted** on a session that encrypts everything else. It is neither `.m3u8` nor `.vtt`, so it fell outside the LMCENC scope by definition rather than by decision. It leaks the shape of the audio and nothing else — but a listener who cares about the loud parts can find them. Either widen the scope or record that this is deliberate.

**`encryptPlaylists` has no UI.** It follows `encryption.enabled` and can only be overridden through a direct `POST /api/sessions` — neither the CMS handshake nor the app offers the opt-out. That is the right default; the question is whether anything needs to reach the escape hatch, which the stock-player check in item 0 decides.

## 11. Always fMP4, and one chunk instead of many

Two related questions about what the encoder writes. Both are about the shape of the output rather than its content, so both are cheapest to answer before anyone depends on the current shape.

### 11a. Align the streams, and stop falling back to MPEG-TS

**Today.** `areStreamStartTimesAligned` probes the per-stream start times of the tracks an encode will actually use. Under 50 ms of spread, the output is fMP4 (`.m4s` + `init.mp4`); over it, the whole encode falls back to MPEG-TS, because hls.js's TS→fMP4 transmuxer resynchronises audio and video PTS during playback while fMP4 segments are appended directly and rely on `tfdt` being right. The choice is reported as `segmentFormat`. So the container is decided by a property of the source file, and a camera that starts its audio a tenth of a second late costs every viewer the TS overhead.

**Wanted.** Trim every stream to the start of the latest-starting one before encoding, so the timestamps align by construction and fMP4 is always available. What is lost is the leading fraction of a second of whichever streams began early — usually inaudible, and it should be measured rather than assumed on a real multi-camera source.

**Worth knowing before reaching for GStreamer.** FFmpeg can already do this: per-input `-ss`, or `-itsoffset`, or re-stamping with `setpts=PTS-STARTPTS` / `asetpts=PTS-STARTPTS`, which is the same machinery the trim feature already uses. GStreamer may still win on a source FFmpeg mis-probes, but the cheap experiment is to align in FFmpeg first and see whether the fallback ever fires again.

**Why it is worth doing.** Lower overhead than TS's 188-byte packets, one code path instead of two, and fMP4 is CMAF — which is what any future DRM (Widevine, FairPlay) needs. It also removes a fallback that is invisible until someone wonders why one encode's segments look different from another's.

### 11b. One chunk carrying every stream, instead of one per stream

**Today.** Byte-range packing concatenates each stream's segments into `media_<n>.<ext>` files inside that stream's own directory, capped at `byteRangeMaxFileSizeMB` (500 by default), and rewrites the playlist as `#EXT-X-BYTERANGE:<length>@<offset>`. Every variant, angle and audio rendition therefore has its own chain of files.

**The idea.** Pack across streams instead: one chunk file holding every video quality and angle and every audio track for the same stretch of time, up to the size cap, with each media playlist pointing into it at its own offsets. Fewer objects; a CDN edge that has the chunk has it for every quality, so a mid-stream quality switch may cost no origin fetch at all.

**What decides it.** Whether the CDN fetches ranges or objects. An edge that satisfies a range request by pulling the whole object turns every request for one 480p segment into a fetch of every quality's bytes for that period — worse on a cold cache and much worse on metered mobile. Some CDNs do segmented range caching and would be fine; that behaviour, on the CDN Luminary actually uses, is the experiment worth running before any of this is built.

**Three things it would collide with.** Audio-only mode is built on the promise that no video bytes are fetched at all — a merged chunk breaks that promise unless audio stays in its own file, which may be the right compromise anyway. Segments are encrypted before they are packed, so offsets are ciphertext offsets and interleaving changes nothing about that, but it does mean a shared chunk mixes several streams' ciphertext under one key. And the streaming pipeline currently packs each stream independently as its segments arrive; packing across streams means holding segments until every stream has produced that stretch, which is a different memory and latency profile.

The lossless playlist model and `player-core` both pass `#EXT-X-BYTERANGE` through untouched, so neither change is blocked on the player.
