# Todo — follow-up work

Deferred work and known gaps after the local-only Electron migration. Each item states what exists today, what is missing, and where the work lands. Nothing here is a bug report against shipped behaviour; these are things deliberately left for later.

Ordered roughly by value, not by effort.

---

## 0. Handover state (read this first)

**Branch.** All migration work (issue #154, phases 1–10) is committed on `154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features` as seven logical commits (SaaS removal → hls lib → api → app → cms-mock → electron → docs). Phases that shared files were grouped by subsystem rather than split by hunk.

**Build state.** All workspaces build (`hls`, `api`, `app`, `cms-mock`, `electron`). Test suites are intentionally red (item 6). A packaged macOS `.app` (`npm -w electron run dist:mac`) was built and verified to boot the embedded API and serve the UI.

**Manual end-to-end verification has NOT been done yet.** What was verified during implementation was per-phase smoke testing (curl-level: CMS create/idempotency/403, SSE events with `hlsUrl` + `encryptionKeyHex`, local-file ingest by reference, credential redaction + restart recovery, packaged-app boot). Still outstanding — the acceptance pass:

- [ ] Full cms-mock flow in Chrome (`npm run dev` + `npm -w cms-mock run dev`, http://localhost:5199): health check → create against MinIO → TOFU/origin gating → SSE console → "not available yet" → playback proof. Verify the LNA/PNA preflight in devtools.
- [ ] Real encode end-to-end from the Electron app (`npm run dev:electron`, note: unset `ELECTRON_RUN_AS_NODE` if your shell exports it): drag-drop path extraction, click-to-browse, trim, chapters, encrypted playback via `luminary://key` swap.
- [ ] Multi-angle source: single `master.m3u8` with `#EXT-X-MEDIA:TYPE=VIDEO` groups in S3; angle switching + audio-only in the app player (client-side extraction).
- [ ] **Stock-player check (flagged risk, never tested):** confirm plain video.js/hls.js plays the *default angle* of a raw multi-angle master without the extraction helpers — Luminary clients that have not adopted `hls/` helpers depend on this.
- [ ] Kill the app mid-encode → relaunch: non-terminal session restored as failed with the credentials-recovery behaviour; terminal sessions gone after restart.
- [ ] Queue: three CMS sessions encoding FIFO with SSE `queuePosition` updates.
- [ ] Protocol handler from a packaged install: `open luminary-convert://` launches/focuses the app.
- [ ] Packaged mac build encodes with `encoder: 'apple'` (VideoToolbox) — note ffmpeg/ffprobe are **not bundled** yet (item 5a); the packaged app currently falls back to PATH.

**Tests are not to be fixed until the manual verification above has been done and the owner explicitly asks** (item 6).

---

## 0b. CMS-side integration (bccsa/luminary — out of this repo)

The encoder's half of the contract is done and documented (CLAUDE.md "CMS contract"; `cms-mock/` is the executable reference). The Luminary side still needs, on branch `1878-api-cms-hls-media-data-model` or successor:

- The "upload / edit media" button: health-check `GET /api/cms/health` on `http://127.0.0.1:31711`, `luminary-convert://` launch fallback, then `POST /api/cms/sessions` (Chrome LNA; Chrome-only at time of writing).
- SSE consumer on `eventsUrl`: on the first `encoding` event, save `MediaDto { hlsUrl, hlsKey: encryptionKeyHex }` — the post can be saved before encoding completes.
- Player-side: "not available yet" notice while `hlsUrl` 404s; adopt the `@luminary-media-converter/hls` extraction helpers (`listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist`) and the `luminary://key` → crypto-object key swap for encrypted playback.
- Passing `existingMedia { hlsUrl, hlsKey }` for edit mode once item 1 lands (the DTO already accepts it).

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

## 5a. Bundle ffmpeg/ffprobe binaries (macOS too)

**Today.** `electron/bin/` contains only a README. The packaged app looks for `ffmpeg`/`ffprobe` under `process.resourcesPath` and, finding nothing, falls back to whatever is on the user's PATH — which on a clean end-user Mac is nothing. The packaged-app verification so far only proved the server boots and serves the UI, not that it can encode on a machine without Homebrew ffmpeg.

**Needed.** Source a VideoToolbox-enabled darwin-arm64 `ffmpeg`/`ffprobe` pair into `electron/bin/darwin-arm64/` (see `electron/bin/README.md` for sources and licence notes), confirm `extraResources` places them and `ffbin.ts` resolution picks them up in a packaged build, and verify an encode reports `encoder: 'apple'`. The Windows equivalent is folded into item 5.

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

## 7. Origin trust management UI

**Today.** Allowed and denied origins are decided in a one-time native dialog and persisted to `settings.json` in the app's `userData` directory. There is no way to review them, revoke an allow, or undo a mistaken deny except by editing that file by hand and restarting. A user who clicks "Block" on their own CMS has no route back inside the product.

**Wanted.** A small settings surface in the renderer listing trusted and blocked origins with a remove action per entry. The API side already has most of what is needed: `OriginRegistry.list()` exists and is currently unused; it needs a matching `revoke()`, an endpoint (instance-token authenticated), and a write-back into the Electron settings file. Note that the registry is also the CORS decision point, so revocation must take effect without a restart.

---

## 8. Session focus refinement in the Electron main process

**Today.** `onCmsSessionCreated` receives the `sessionId`, and `electron/src/main.ts` throws it away: `onCmsSessionCreated: () => focusWindow()`. The window comes forward, but on whatever session the user was last looking at. When a CMS opens a session for a different post, the user is shown the wrong one and has to find the new one in the list.

**Wanted.** Route the id through to the renderer — an IPC event the app listens for and navigates to `/sessions/:id` on — so the click in the browser lands on the session it created. Worth handling the case where the window does not exist yet (the app was launched by the protocol handler): the navigation has to be held until the renderer is ready.

---

## 9. Housekeeping

Small, low-risk, and each independently droppable.

- **Deployment artefacts from the service era.** `api/Dockerfile` and `.github/workflows/api-deploy-{prod,staging}.yml` still build and deploy the API as a long-running container to remote hosts. If the API is only ever embedded in the desktop app, these are dead weight and misleading; if running it as a shared service is still a supported mode, that should be stated somewhere rather than implied by a Dockerfile. Decide, then either document or delete. `api-unit-tests.yml` stays either way (see item 6).
- **Stale SaaS-era documents.** `docs/URS-saas-adaptation.md`, `docs/FDS-saas-adaptation.md` and `docs/implementation-plan.md` describe the multi-tenant product. `security-review.md`, `security-audit-v1.md` and `privacy-review.md` are dated audits of a codebase that no longer exists in this shape (`privacy-review.md` now carries a note saying so). Archive them, or re-run the security and privacy reviews against the local-only architecture — the threat model changed completely: no shared service, no user database, credentials in an OS keychain, and a new network-facing surface in the CMS origin gate.
- **Naming: `MASTER_API_KEY` vs the instance token.** The injection token is `LOCAL_API_TOKEN`, the env fallback is `MASTER_API_KEY`, the guard calls it `masterKey`, and `@AuthTypes('master')` names the tier. It is one thing with four names, and "master key" carries multi-tenant connotations it no longer has. A rename to something like `LOCAL_API_TOKEN` throughout (with the old env name accepted for a release) would remove a recurring source of confusion.
- **Unused DTOs.** `api/src/encode/dto/rendition.dto.ts` and `review-range.dto.ts` are not referenced by any controller or service.
- **Swagger metadata drift.** `bootstrap.ts` hardcodes `.setVersion('2.0.0')` while `version.ts` reads the real package version for the CMS handshake, and the `X-API-Key` security scheme description still says "(MASTER_API_KEY)". Use `API_VERSION` and reword.
- **Read tokens never expire.** A `read_*` token is valid for the life of the session record and is only invalidated when the session is removed. That is fine for a watch-only credential on loopback, but it is worth a deliberate decision rather than an accident.
- **`byteRange` is not reported in the status response.** The session status DTO doesn't expose whether byte-range packing was enabled, so `SessionView` pins `byteRangeEnabled = true` (the API default). Either add the field to `SessionStatusDto` or drop the UI's dependence on it.
- **Prettier baseline.** Several touched api/ files (`encryption.service.ts`, `encode.service.ts`, auth files, others) were already prettier-unclean at HEAD and remain so — new code follows the surrounding style, but a one-off `prettier --write` pass on api/src would clear the noise. Do it as its own commit.
