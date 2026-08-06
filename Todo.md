# Todo — follow-up work

Deferred work and known gaps after the local-only Electron migration. Each item states what exists today, what is missing, and where the work lands. Nothing here is a bug report against shipped behaviour; these are things deliberately left for later.

Ordered roughly by value, not by effort.

---

## 0. Handover state (read this first)

**Branch.** All migration work (issue #154) is on `154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features`, open as PR #161. The original seven logical commits (SaaS removal → hls lib → api → app → cms-mock → electron → docs) have since been joined by the manual-verification fixes, the app icon, a merge of `main`, and the restored test suites.

**Build state.** All workspaces build, and all test suites pass: api 741, app 178, segment-editor 217, hls 26 (item 6). `vue-tsc` typechecks the specs again. A packaged macOS `.app` and `.dmg` were built and verified to boot the embedded API, serve the UI, and carry the app icon.

**Manual verification — mostly done.** A full pass was run through the Electron app and `cms-mock` against a local MinIO: CMS handshake and idempotency, TOFU origin gating, local-file ingest by reference, probe, trim, encode, SSE with `hlsUrl` + `encryptionKeyHex`, encrypted playback via the `luminary://key` swap, chapters, session delete, and credential recovery across a restart. Several defects were found and fixed in the process (storyboard cue clipping at a trim in-point, trim semantics, timeline duration during an encode, playhead clipping at the ends, waveform contrast on an audio source, storyboard polling on a source with no video track).

Still outstanding:

- [ ] Multi-angle source: single `master.m3u8` with `#EXT-X-MEDIA:TYPE=VIDEO` groups in S3; angle switching + audio-only in the app player (client-side extraction).
- [ ] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the *default angle* of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls/` helpers depend on this.
- [ ] Queue: three CMS sessions encoding FIFO with SSE `queuePosition` updates.
- [ ] Protocol handler from a packaged install: `open luminary-convert://` launches/focuses the app.
- [ ] Packaged mac build encodes with `encoder: 'apple'` (VideoToolbox) — blocked on item 5a; the packaged app currently falls back to PATH, so it cannot encode on a machine without a system ffmpeg.

---

## 0b. CMS-side integration (bccsa/luminary — out of this repo)

The encoder's half of the contract is done and documented (CLAUDE.md "CMS contract"; `cms-mock/` is the executable reference). The Luminary side still needs, on branch `1878-api-cms-hls-media-data-model` or successor:

- The "upload / edit media" button: health-check `GET /api/cms/health` on `http://127.0.0.1:31711`, `luminary-convert://` launch fallback, then `POST /api/cms/sessions` (Chrome LNA; Chrome-only at time of writing).
- SSE consumer on `eventsUrl`: on the first `encoding` event, save `MediaDto { hlsUrl, hlsKey: encryptionKeyHex }` — the post can be saved before encoding completes.
- Player-side: "not available yet" notice while `hlsUrl` 404s; adopt the `@luminary-media-converter/hls` extraction helpers (`listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`) and the `luminary://key` → crypto-object key swap for encrypted playback.
- Passing `existingMedia { hlsUrl, hlsKey }` for edit mode once item 1 lands (the DTO already accepts it).

---

## 0c. Deployment workflows — decide before merging to main

**Blocking.** Not a refinement: merging this branch to `main` as it stands will break the staging deploy.

`.github/workflows/api-deploy-staging.yml` fires on a push to `main` filtered on `api/**`, and this branch rewrites all of `api/`. The job writes an `api/.env` and runs the API as a container — but:

- The generated `.env` carries **no `HOST`**, and the API now defaults to `127.0.0.1` (`DEFAULT_HOST` in `api/src/bootstrap.ts`, read by `main.ts`). That default is correct for a desktop app and wrong for a container: bound to the loopback interface inside its own namespace, the process is unreachable through `docker run -p`. The job judges success on the app answering, so it will fail — after it has already replaced the running container.
- The `.env` sets `CORS_ORIGIN`, `MASTER_API_KEY`, `KEY_VALIDATION_WEBHOOK_URL`, `MAX_UPLOAD_SIZE`, `S3_UPLOAD_CONCURRENCY`, `TUSD_BINARY_PATH` and more, of which the current API reads almost nothing. The origin allowlist is `CMS_ALLOWED_ORIGINS` now, not `CORS_ORIGIN`.

`api-deploy-prod.yml` is the same shape on the `prod` branch.

**The decision, which is a product one.** Is running the API as a shared remote service still a supported mode?

- **If no** — delete both deploy workflows and `api/Dockerfile`. They are dead weight that currently reads as a supported deployment. `api-unit-tests.yml` stays.
- **If yes** — it needs saying somewhere, and the workflows need `HOST=0.0.0.0` in the generated `.env` plus a pass over the variables. It also needs a threat-model answer the local-only design does not currently give: as a desktop app the API is reachable only from the machine it runs on, and the origin allowlist assumes exactly that.

Either way, do it before the merge rather than discovering it from a red deploy.

---

## 1. Edit mode for existing HLS collections

**Today.** `CmsCreateSessionDto.existingMedia` (`{ hlsUrl, hlsKey? }`) is validated and accepted, and then ignored — every CMS session produces a brand-new collection in its own `<pathPrefix>/<sessionId>` subfolder. A user who wants to add one audio language to an existing post re-encodes everything, gets a new URL and a new key, and leaves the old collection behind.

**Wanted.** When the CMS sends `existingMedia`, the app should open the collection instead of starting from a blank session:

- **Import** — resolve `hlsUrl` back to a bucket/prefix and use `POST /api/hls/discover` + `POST /api/hls/read` to enumerate what is there: video angles, audio renditions, subtitle tracks, chapters, thumbnails, waveform sidecar. `deriveAngleName` and `normalizeS3Key` in `hls/src/keys.ts` already exist for this.
- **Playback with the supplied key** — `HlsPlayer` already does client-side `#EXT-X-KEY` substitution; it needs to take `hlsKey` from the CMS rather than only `encryptionKeyHex` from a session it ran itself.
- **Chapter editing on an imported collection** — the session-scoped chapter routes resolve the prefix from the session's own S3 config; an imported collection needs the same against a discovered prefix (the stateless `/api/hls/chapters/{read,write}` routes already do exactly this).
- **Track management** — add / remove / replace an individual audio track or video angle without touching the rest:
  - new `hls-edit` operations alongside `upsertSubtitle` / `removeSubtitle` / `upsertChapters` / `removeChapters` in `api/src/hls-edit/operations/index.ts` (e.g. `upsertAudioRendition`, `removeAudioRendition`, `upsertVideoAngle`, `removeVideoAngle`)
  - single-track encodes that write into an existing prefix and are encrypted with the **existing collection key**, not a freshly generated one — `EncodeService` currently always calls `encryptionService.generateKey()`, so it needs a path that takes a supplied key
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

| Workspace | Result |
|---|---|
| `api/` | 22 files, 741 tests |
| `app/` | 10 files, 178 tests |
| `segment-editor/` | 5 files, 217 tests |
| `hls/` | 4 files, 26 tests |

Rewritten against what the code does now rather than patched into passing. Two suites were deleted rather than repaired, because their subject moved: the angle and audio-only playlist generation in `ffmpeg.service` (the encoder writes one spec-correct master and the player narrows it), and everything about webhook delivery in `encode.service` (the CMS watches over SSE).

New coverage for what the migration added and nothing tested: `OriginRegistry` (33) and `CmsController` (31) — the origin allowlist is the whole perimeter for a remote caller, since the API binds to the loopback interface of someone's laptop. Credential redaction and restore in `SessionService` is covered too.

**Two defects the new tests found**, both fixed here:

- `createCorsOptions` promised in its own comment to refuse by withholding the header and never by raising, but called `registry.isAllowed(origin)` before building the promise, so only an async rejection was caught. `isAllowed` has a synchronous return path and calls the host's approver directly — a native dialog throwing synchronously would have become a 500 on a request the API meant to quietly turn away.
- `encode.service.spec` constructed `EncodeService` with eight services when it takes seven, so every assertion in that suite was made against the wrong object. `encode.controller.spec` had the same fault with nine.

**Still worth adding.** `hls/src/angles.ts` extraction against real multi-angle masters — the natural home for the coverage deleted from `ffmpeg.service`. And `cms-mock/` has no tests at all, deliberately: it is a dev-only bench, nothing depends on it, and its bugs surface immediately in use.

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

**Still open.**

- **Re-run the security and privacy reviews** against the local-only architecture. The archive README lists what changed in the threat model; that is the input, not the answer.

---
