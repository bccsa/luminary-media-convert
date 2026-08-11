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
- [ ] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the _default angle_ of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls/` helpers depend on this. **Now has a second half:** with #162 an encrypted session also encrypts its playlists (LMCENC), which no stock player can read at all — such a client needs `encryption.encryptPlaylists: false` until it moves to `player-core`. Worth testing both, since the answer decides whether that opt-out is a transitional courtesy or a permanent mode. **Mostly answered below (§0a) — one browser run outstanding.**

### 0a. Stock-player check — results

Five outputs were encoded into a local MinIO and opened with **ffmpeg's HLS demuxer**, which is a genuinely third-party stock client: it reads master playlists, picks a variant, and fetches AES-128 keys by URI, with no knowledge of anything in this repo.

| # | Output | Stock client does | Prefix in `media/` |
|---|---|---|---|
| 1 | Plaintext, single angle | **plays** (300/300 frames over 10 s) | `measure27b` |
| 2 | Plaintext, multi-angle | **plays** — but see below | `sp-multiangle` |
| 3 | Encrypted, playlists encrypted (the default) | **fails at the master** — LMCENC01 ciphertext is not a playlist | `772e6978-…` |
| 4 | Encrypted, `encryptPlaylists: false`, no `keyUrl` | **fails at key load** — "Unable to open key file luminary://key" | `sp-enc-sentinel` |
| 5 | Encrypted, `encryptPlaylists: false` + a fetchable `keyUrl` | **plays** | `sp-enc-keyurl` |

**The opt-out alone is not enough, and that answers the question the item posed.** `encryptPlaylists: false` gets a stock client as far as parsing the playlist and no further: `#EXT-X-KEY` still names `luminary://key`, a scheme no player can resolve (case 4). Playing encrypted output on a stock client needs *both* the opt-out *and* an `encryption.keyUrl` serving the raw 16 key bytes over HTTP — and this encoder has no key server and should not grow one: the key is generated locally precisely so that it never leaves the machine. Case 5 only passes because a key file was placed in the bucket by hand, which publishes the key next to the content it protects and is therefore a test fixture, not a pattern to offer anyone.

So the honest guidance for a Luminary client that has not adopted `player-core`: **use unencrypted output.** The opt-out is for a client that has its own key delivery, not a way to make encrypted output generally playable. It is a permanent mode in the sense that it will keep working, but not a migration path on its own.

**Multi-angle is worse than "plays the default angle" — and the flagged risk is real.** A stock client played case 2, but it fetched segments from *both* angle playlists. Nothing in a spec-correct multi-angle master marks a variant as an alternate camera rather than a bitrate rung: two variants at the same resolution with different `BANDWIDTH` are exactly the shape of an ABR ladder, and `DEFAULT=YES` on the `TYPE=VIDEO` group does not constrain variant selection — it is advice about a rendition group most players ignore entirely. An ABR algorithm is therefore free to move between angles as the network changes, so a stock client can silently cut from Wide to Close mid-playback. It plays; it does not play *one angle*. Narrowing with `extractAnglePlaylist` is not a nicety for these clients, and a Luminary client that will not adopt the helpers should be sent single-angle output.

Also observed and dismissed: cases 1 and 2 emit `Invalid NAL unit size` / `missing picture in access unit` warnings when opened **through the master**, never through the media playlist directly, and decode 300/300 frames over 10 s regardless. That is ffmpeg probing a byte-range fMP4 fragment without first reading its `#EXT-X-MAP` init segment — an artefact of the probe, not a defect in the output. It is absent on case 5 because an encrypted fragment cannot be probed that way at all.

**Outstanding: the browser half.** ffmpeg settles the structure but is not hls.js and is not Safari. A harness is committed for that — [`docs/stock-player-check/`](docs/stock-player-check/README.md), which loads hls.js with **default config** (no custom loader, no munging, no key injection) and offers a native-`<video>` button per case for Safari's built-in HLS. Its README has the two commands. Expected per the table above; the interesting rows are 2 (does hls.js's ABR actually cross angles?) and 4 (does it report a key error or a manifest error?). Note the whole exercise settles the *web* only — AVPlayer and ExoPlayer remain untested, which matters when the Capacitor adapters land (item 6).
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

The transport belongs to the same trip, now that item 30 has put three buttons in the middle of the picture where there was one. They hold the 44 px minimum and separate on a fluid gap as the viewport narrows, but that is a claim about the stylesheet: whether skip-back, play and skip-forward can be told apart and hit with a thumb, on a phone held in landscape, is not something jsdom or a desktop pointer can answer.

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

### 11b. One chunk carrying several streams, instead of one per stream

**Today.** Byte-range packing concatenates each stream's segments into `media_<n>.<ext>` files inside that stream's own directory, capped at `byteRangeMaxFileSizeMB` (500 by default), and rewrites the playlist as `#EXT-X-BYTERANGE:<length>@<offset>`. Every variant, angle and audio rendition therefore has its own chain of files.

**The idea.** Pack across streams: one chunk holding every video quality for the same stretch of time, with each media playlist pointing into it at its own offsets. Fewer objects, and — the reason that actually matters — an edge holding the chunk holds it for every quality, so a mid-stream quality switch costs no origin fetch.

**The CDN premise, corrected.** An earlier version of this note worried that an edge which pulls the whole object to satisfy a range would turn a request for one 480p segment into a fetch of every quality's bytes, and be "much worse on metered mobile". That is wrong. Such an edge forwards the requested range to the client immediately and backhauls the remainder behind it; the client never receives bytes it did not ask for. The whole-object pull is origin backhaul, not client traffic, and it leaves the edge warm for everything else in the chunk. **This design targets CDNs that serve byte ranges natively that way.** An edge that genuinely refuses ranges, or that caches only whole objects it has fully fetched, would need this reconsidered from the start.

**Why merging wins on that kind of edge.** With per-stream chains a cold start triggers at least two concurrent backhauls — the audio chain and whichever rendition ABR picked — and between them they warm exactly one quality. The pathological case is a quality step-up landing on a rendition whose chunk is not at the edge: a cold pull at precisely the moment the player decided it had headroom. One chunk per angle warms every rendition of that angle in a single pull and removes that case entirely.

**The layout.**

- **One video chunk chain per angle**, holding every rendition of that angle. A single-angle encode gets one chain and needs no special case.
- **One audio chunk chain**, holding every audio group, with a smaller cap so its boundaries stay rare and its backhaul stays quick.
- Chains independent and separately capped, and deliberately *not* boundary-aligned — letting the chains' boundaries drift past each other avoids paying two cold pulls at the same instant.

Splitting audio out is forced by the per-angle split rather than chosen: were audio merged into the angle chunks it would be duplicated into each one and backhauled once per angle, which is the waste the merge was meant to avoid; leaving it in a single angle's chunk would make every other angle fetch two chunks anyway. Carrying that split into single-angle encodes too costs one extra small pull at cold start and buys a layout that does not change shape with the angle count — and it restores the audio-only promise properly: an audio-only client pulls from the audio chain and never triggers a video backhaul at all.

**The principle underneath, which is what decides future cases.**

- Streams a viewer swaps between **frequently and automatically** — renditions, where ABR re-decides every few seconds — belong in the *same* chunk. Warmth is worth the higher byte rate, because the swap happens constantly and a cold pull arrives exactly when the player wanted to step up.
- Streams a viewer needs **concurrently** — audio and video — belong in *separate* chunks. Merging them saves one pull and nothing else; splitting them costs one small pull and keeps audio-only honest.
- Streams a viewer switches between **rarely and deliberately** — angles — belong in *separate* chunks. Merging taxes every viewer with boundaries several times more frequent, to spare the occasional switcher a dip they asked for themselves and will tolerate.

**Chunk sizing.** Ramp it. A fixed cap means the first chunk of an asset is full size, so the first viewer waits on the largest possible backhaul at the worst possible moment. Start small — roughly ten seconds of the chain's streams — and grow toward the cap: startup warms almost at once, and a short view stops dragging a full-size pull for a few seconds of watching. The cap itself stops being a tuning knob and becomes a correctness constraint, because a chunk larger than the edge's cacheable maximum is not cached at all and the failure mode is a silent performance regression with no error anywhere. Worth an explicit guard and a log, with the limit staying configurable.

**Boundary crossings.** Merging raises the byte rate per second of timeline, so boundaries come round more often than in the per-stream design. Near the end of a chunk the player starts requesting ranges from the next one, which is cold, and quality may dip until it lands. The dip is predictable — `player-core` can see the chunk filename change in the byte-range URIs, so it knows where the boundary falls — so warm the next chunk with a small range request some seconds ahead, per chain. That turns "the backhaul is usually fast enough" into designed behaviour rather than an assumption.

**What it collides with — and what it does not.** Audio-only mode is handled by the split above. Segments are encrypted before they are packed, so offsets are ciphertext offsets and interleaving changes nothing about that; a shared chunk does mix several streams' ciphertext under one key, which is already true of a session's output taken as a whole. The third collision recorded here previously — that the streaming pipeline would have to hold segments until every stream had produced a given stretch — is **not real**. Because the edge backhauls the whole file, byte order inside a chunk is irrelevant: nothing requires stream A's data for time T to sit beside stream B's. So no barrier is needed. Keep a single shared append stream per chain, let segments land in whatever order they arrive, and have each stream record `(chunkFile, offset, length)` as it goes. `appendToByteRangeChunk` in `api/src/encode/services/segment-pipeline.service.ts` moves from per-stream state to one shared chunk state plus a serialized appender, and chunks already upload only once complete, so the deferred-upload profile is unchanged.

**Worth verifying before building.** That all of an angle's renditions are emitted by a single FFmpeg process — that is what keeps their segments arriving clustered in time, and it is what makes the no-barrier approach safe. If renditions or angles turn out to run as separate processes, streams can drift far enough apart that a chunk stops covering a coherent window and a soft barrier comes back.

**Order.** Do 11a first. Collapsing to one segment format removes a variable from the packing work rather than leaving it to be handled twice.

The lossless playlist model and `player-core` both pass `#EXT-X-BYTERANGE` through untouched, so neither change is blocked on the player.

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

## 14. Move "Clear All" out of the timeline controls and into the Chapters section

**Today.** `SegmentEditor` renders the Clear All button itself, in its controls row, in every non-`trim` mode where at least one segment exists — twice over, since the row has two render sites (`segment-editor/src/SegmentEditor.vue`, the standalone toolbar around line 1641 and the combined controls bar around line 2070; in `trim` mode the same slot holds Cut instead). So a destructive "remove every chapter" action sits among playback, mark in/out, undo/redo and zoom, which are all timeline-local and mostly reversible-by-habit.

**Wanted.** It belongs beside the chapter list, where the things it deletes are actually visible.

**What that takes.** `clearAll` is already on the component's `defineExpose` surface, so the host can call it — what does not come with it is the confirmation dialog (`confirmClearOpen`, and the "Clear all {{ clearNoun }}?" sheet around line 2386), which either has to be reachable from outside or re-implemented in the chapters panel. Note that the button is generic to non-trim modes, so removing it unconditionally also takes it away from `subtitles` mode; if that mode is meant to keep an in-editor clear, this needs a prop rather than a deletion. `segment-editor` is a published library with its own suite — check for tests asserting the button's presence.

---

## 15. Session topline belongs in the left pane, not in a full-width top bar

**Today.** The session topline — back arrow, title, status badge, "Created 17 hours ago", and the encode action — is a full-width row above both columns (`app/src/views/SessionView.vue`, `.session-topline` around line 1752, rendered above the `SessionTrimWorkspace` that draws the player and its `#aside` slot). The aside therefore starts one row down, and the chapters pane opens with a band of empty space above it.

**Wanted.** Move the topline inside the left (player) column, so the aside runs to the top of the window and the chapters pane starts there. The title also reads better beside the thing it names than as a page-wide chrome bar.

**Watch out for.** The topline carries the encode submit button, which is the primary action of the pre-encode phase — narrowing its row to the player column has to leave it somewhere it is still obvious. It also has an `order-first` special case for the `trim` tab, and the back arrow is the only route out of the session view.

---

## 16. Chapters pane: too much left and right padding

**Today.** The chapters panel insets its content well away from the panel edge on both sides, which costs the chapter-title field width — the part of each row that actually needs it — while the timecode, duration and remove controls stay fixed.

**Wanted.** Tighten the horizontal padding. Worth doing together with item 15, since both are about the same pane's use of space, and with item 13, which removes the tab row above it.

---

## 17. Timeline control buttons do not match the rest of the app

**Today.** The controls bar under the timeline (mark in/out, undo/redo, step, play/pause, zoom) is styled entirely from `segment-editor/src/styles.css`, which carries its own theme tokens. In dark mode `--se-track: #172554` / `--se-track-hover: #1e3a5f` (line 69–70) give every `.se-btn` a deep navy fill, while the app's own buttons around it are slate. So the timeline reads as a component borrowed from somewhere else.

**Wanted.** Bring the button surfaces onto the app's palette — for the dark theme that is the slate family, not blue-950.

**Play/pause needs a separate decision.** `.se-btn--playback` (line 584) is the only button given the accent treatment: sky border, `--se-accent-soft` fill, sky icon. Against navy neighbours that reads as an outlined toggle rather than the primary control, and on a slate bar it will read differently again. Worth deciding what it should be — solid accent fill, or plain like its neighbours since the timeline already has a keyboard space bar and a playhead to say what is happening — rather than just recolouring what is there.

**Note.** `segment-editor` is a published library with its own token block and a light theme alongside the dark one, so this is a change to the library's defaults (both themes) or a set of overrides the app supplies — decide which, because the library is meant to be host-agnostic.

---

## 18. Theme popup: smaller, icons instead of tick-boxes, close on select

**Today.** `app/src/components/AccountMenu.vue` opens an 18rem panel with an "APPEARANCE" heading and three rows, each a bordered square that holds a checkmark when selected, a bold label and a second line of description ("Always light" / "Match system" / "Always dark"). `pickTheme` (line 86) sets the preference and leaves the panel open.

**Wanted.**

- Smaller overall — the panel is wider and taller than three mutually exclusive options need.
- Icons in place of the tick-box column (sun / auto / moon), matching how the Luminary app presents the same choice. Selection then has to be shown some other way — a highlighted row or a tinted icon — since the checkmark is what carries it today.
- Close the popup on selection. `close()` already exists; `pickTheme` just does not call it.

**Watch out for.** The rows are `role="menuitemradio"` with `aria-checked`, which is the part that must survive losing the visible checkbox; and the same component renders in two places via the `variant` prop (`editor` uses the `se-btn` trigger inside the timeline controls bar, the default is the round nav button), so both placements need looking at. Dropping the description line may make the labels alone ambiguous — "Auto" is the one that carries its meaning least well on its own.

---

## 19. Split divider between the player and the side pane is too bright in dark mode

**Today.** The vertical rule is `.session-split-handle__bar` in `app/src/components/session-view/SessionPlayerStrip.vue` (styles from line 543). Its rest colour is `slate-200` with a `:global(html.dark)` override to `slate-700/60` — but on screen in the dark theme it reads as a near-white line running the full height of the view, far louder than anything else on the page.

**Worth checking first whether the dark override is applying at all**, since `slate-200` is exactly what a failed override would look like. If it is applying, then `slate-700/60` is simply too bright against this background and wants to come down. The hover / focus / active states (sky, 2px) are doing their job and should stay — the rest state is the problem.

---

## 20. Timeline timecode is over-emphasised

**Today.** `.se-controls-bar__time` (`segment-editor/src/styles.css`, line 799) is `1rem` monospace at `weight: 600` in full `--se-text`, while the buttons beside it are `0.75rem` at `weight: 500`. It is the loudest thing in the controls bar, and it is a readout rather than a control.

**Wanted.** Smaller, or lighter, or both — enough that the transport buttons lead the bar. Monospace should stay: the digits must not jump width as the playhead moves.

**Note.** There is a second readout with the same treatment — `.se-time-above` (line 929), `0.9375rem` at `weight: 600`, used when the controls are not in the combined bar. Both should move together, or the two layouts will disagree.

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

## 23. Validate language codes

**Today.** Language is a free-text input in two places in `encode-config/src/EncodeConfigForm.vue` — per audio track (line 680, placeholder `und`) and per audio group (line 1085, placeholder `eng`). Nothing validates or normalises what is typed, so a typo, a two-letter code or a stray capital travels straight into `#EXT-X-MEDIA:LANGUAGE=` and out to every player.

**Wanted.**

- Accept only valid ISO 639-2 three-letter codes.
- Lower-case on input, so `ENG` and `eng` are the same entry rather than two.
- `mul` and `und` must both pass — they are real ISO 639-2 codes (multiple languages; undetermined), not escape hatches, and both already appear in this app's own output.

**Decide.** Whether an invalid code blocks the encode or only warns, and whether the check is client-side only or also on `EncodeConfigDto` — the API accepts an arbitrary string today, and `POST /api/sessions` is a supported integration surface, so a validator in the form alone leaves the gap open for the CMS route and any direct caller.

**Note.** ISO 639-2 has B/T variants for some languages (`ger`/`deu`, `fre`/`fra`), so the accepted set has to include both or reject codes that are perfectly valid. Interacts with item 22: if `und` is going to be treated as "absent" for label restoration, it still has to remain a *valid* thing to type.

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

## 25. Keyboard shortcut for Cut in trim mode

**There is one already**, which makes this a discoverability or a reachability problem rather than a missing feature — worth establishing which before building anything. `Delete` and `Backspace` both call `deleteSelected()` (`segment-editor/src/SegmentEditor.vue`, line 1044), the trim workspace mounts the editor with `keyboard-scope="global"` so the window listener is attached, and the Cut button's own tooltip advertises it: "Cut the selected range · Delete".

Three things could make it feel absent:

- **It needs a selection.** `deleteSelected` returns immediately when nothing is selected, so pressing Delete after marking in/out — without the range being *selected* — does nothing and gives no feedback. If the intent is "cut what I just marked", that is a different action from "cut what is selected".
- **Focus in a text field swallows it.** `onKeyDown` bails when the target is an `input`/`textarea`/`select`, so Delete pressed after typing in a chapter title never reaches the editor. Correct for typing; surprising if focus is somewhere the user has forgotten about.
- **Delete is not a conventional Cut binding.** `⌘/Ctrl + X` is what a user reaches for, and it is unbound.

**Wanted.** Decide between adding `⌘/Ctrl + X` as an alias, making the shortcut act on the marked range when nothing is selected, or simply surfacing the existing binding better (the `?` help sheet is already there). Whatever is chosen, the help sheet and the button tooltip both have to say the same thing — they are the only places the binding is written down.

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

All three parts answered: the silence is fixed, the duration is measured, and the player-reload question turns out to have been settled already.

**It says what it is doing.** `PipelineProgress` gains a `phase`, reported as each post-drain step begins and cleared before the status flips to `uploading_to_s3` — otherwise the last step captions the upload that follows it. The client renders it under the Encoding bar: "Packing segments…", "Generating thumbnails…", and so on. An unrecognised phase renders nothing, so an older client against a newer API degrades quietly rather than printing a raw identifier. Carried on `pipelineProgress` rather than as new statuses, as this item suggested: these are not states a session can be resumed or cancelled in, they are commentary on the one it is already in.

Each phase is also timed into the log, because a measurement nobody can repeat is worth little — the answer depends on the source, the machine, and whether the sprite pass had a concat file to work from.

**Measured, on a 20-minute 1080p source, Apple Silicon with VideoToolbox:**

| Phase | Time |
|---|---|
| draining | 1.7 s |
| **thumbnails** | **114.7 s** |
| waveform | 0.0 s (served from the cache primed at ingest) |
| encrypting-playlists | not run — session unencrypted |

The encode itself took 125 s, from 19:29:43 to 19:31:48; the silent stretch ran to 19:33:43. **So the wait is as long as the encode, and it is entirely the sprite pass.** Roughly six minutes on an hour-long source. The waveform and the drain are free, and this item's guess that thumbnails were the suspect was right.

**The player reload needs no change, and the reason is already written down.** `activePlaybackUrl` deliberately holds at "delivered output or nothing" once completed, and the comment there explains why reaching earlier is wrong: before completion the key may not be settled, so switching at encode start would either play a stream the client cannot decrypt or fall back to the preview indefinitely — "the wrong renditions, transcoding on this machine for as long as anyone watches". The reload was never the wait; the 115 seconds in front of it were.

**Measuring found the instrumentation's own gap.** `pipeline.drain()` runs before the first phase was reported, so the earliest part of the stretch was unaccounted for. It is now reported as `draining` — 1.7 s here, but it is the step that rewrites byte-range playlists and can still be uploading, so it is not free by construction.

10 tests: 3 on the API (the sprite pass reported, the waveform reported only when the source carries audio, the phase cleared before the status changes) and 4 on the client (each label, silence during the pipeline itself, silence for an unknown phase), plus the earlier 3.

**The optimisation this measurement unlocked is item 34**, which the numbers now justify specifying properly rather than guessing at.

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

## 31. Scrub thumbnails in the player

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

---

## 34. Thumbnail sprites could run alongside the encode, not after it

**Measured in item 27**, which is why this is worth doing rather than worth wondering about: on a 20-minute 1080p source the sprite pass took **114.7 s** against an encode of 125 s. The session takes almost twice as long as it appears to, and every second of the difference is this one step.

**And it has no data dependency on the encode.** `generateThumbnails` is handed `session.filePath` — the **source** file — not the encoded output. It is sequenced after the encode purely by code order in `EncodeService`, not because it needs anything the encode produces. The item 27 note guessed it might overlap the upload; it could overlap the whole encode.

**The one wrinkle.** For a trimmed session the pass needs `concat.txt`, and that file is written by `FfmpegService` *during* the encode (`buildConcatFile`, called from `encode()`). So overlapping needs either the concat produced before the encode starts — which means lifting that out of `FfmpegService` or having `EncodeService` build it — or the concurrency limited to untrimmed sessions, which is a partial fix with a branch in it.

**Watch out for.**

- Sprites must exist before `pipeline.uploadRemainingFiles(outputDir)` sweeps the directory, so the promise has to be awaited where the call sits today. If it finished during the encode, that await is free; the ordering is unchanged, only the waiting is.
- The pass writes into `outputDir`, which is cleared at the start of an encode — so it cannot begin before that clear.
- CPU contention is the real unknown. Video encoding runs on VideoToolbox, but audio, scaling and the sprite pass are all CPU. The win is large enough (115 s serial today) that it is very likely still a win, but it should be measured the same way rather than assumed — the timing logs added in item 27 make that a repeat of the same run.
- Failure stays non-fatal, as it is now: a session without sprites is a session without a scrub filmstrip, not a failed encode.

