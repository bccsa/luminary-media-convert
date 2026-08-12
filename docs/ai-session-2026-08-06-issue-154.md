# AI session log — issue #154: migrate to a local-only Electron app

Session export (2026-08-04 → 2026-08-06). Planning and implementation of
[issue #154](https://github.com/bccsa/luminary-media-convert/issues/154) — the
migration from the SaaS product to a local-only Electron app driven by the
Luminary CMS. Supervised by Claude Fable 5; implementation phases executed by
Claude Opus 5 subagents, each reviewed before the next started. Personal
information, credentials, and machine-specific paths are redacted; file paths
are repo-relative.

---

## 1. Inputs gathered before planning

- **Issue #154 checklist**: remove SaaS API, Auth0, key storage, SaaS-linked
  sessions, Vite PWA, tus uploading; add local sessions (active only) with
  queuing; add an LNA API endpoint for the CMS (S3 details, public S3 URL,
  post title, encryption/chunking/thumbnail requirements; webhook-or-SSE
  status; report the URL to Luminary as soon as encoding starts); direct
  file-on-disk access with drag-drop passing paths; build the Electron app.
- **Luminary CMS data model** (bccsa/luminary, branch
  `1878-api-cms-hls-media-data-model`): `MediaDto { hlsUrl, hlsKey → hlsKey_id }`,
  with `media` / `mediaBucketId` on the parent Post/Tag (`_contentParentDto`)
  copied onto content docs as `parentMedia` / `parentMediaBucketId`. One HLS
  URL per parent.
- **Additional requirements from the owner**: design the CMS↔local-API DTO
  (S3 credentials forwarded on request, handled to discourage extraction;
  post title as session title; default encode settings), and auto-generate
  encryption keys when encryption is selected.

## 2. Codebase exploration (two read-only agents)

Key findings that shaped the plan:

- The `encodingApiUrl` + `sessionToken` pair was the single seam between the
  app and SaaS; `app/src/api.ts` was cleanly bisected into a SaaS half and an
  Encoding-API half.
- `TusUploadService.finalizeUpload(sessionId, path)` was a perfect ingestion
  hook (probe → preview init → status `uploaded` → priming) reusable for
  local-path ingest.
- Encryption keys were already effectively random (random salt into an HMAC),
  so switching to `randomBytes(16)` was safe; `encryptHlsOutput` and the
  encryption worker were dead code.
- No Private Network Access handling existed; `CORS_ORIGIN` env was dead
  config; the server bound 0.0.0.0.
- No notion of a public base URL existed anywhere — completion reported bare
  S3 object keys.

## 3. Decisions locked with the owner

Via structured Q&A during planning, then a `/grill-me` interrogation:

| Decision                   | Choice                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CMS status reporting       | SSE to the CMS browser (webhooks removed entirely)                                                                                                                                       |
| S3 credential handling     | Encrypted at rest via Electron safeStorage; never sent to renderer; redacted in `session.json`; memory-only (no disk) when safeStorage unavailable — sessions then don't survive restart |
| saas/ admin/ tusd/         | Deleted                                                                                                                                                                                  |
| Encrypted playback key URI | Fixed placeholder `luminary://key`, swapped client-side                                                                                                                                  |
| Session creation           | CMS-only (manual EncodeView removed)                                                                                                                                                     |
| "From URL" mode            | Reframed: CMS passes an existing collection URL for **edit mode** (chapters + playback + add/remove/replace audio tracks / video angles) — deferred to a follow-up issue                 |
| Discovery                  | Fixed port `31711` + `luminary-convert://` protocol handler + `GET /api/cms/health`                                                                                                      |
| Correlation                | `documentId` in the DTO; idempotent create returns the active session (`reused: true`) — doubles as the CMS reconnect story                                                              |
| Output placement           | Per-session subfolder `<cms-prefix>/<sessionId>/`; re-encodes never disturb the live collection                                                                                          |
| Origin trust               | Trust-on-first-use native dialog, persisted in app settings                                                                                                                              |
| Retention                  | Active sessions only: terminal sessions until dismiss/quit, never restored on boot                                                                                                       |
| Window UX                  | Dock app; focus window on CMS activity                                                                                                                                                   |
| Platforms                  | macOS arm64 + Windows x64                                                                                                                                                                |
| Updates                    | Manual installs; minimal signing; auto-update deferred                                                                                                                                   |
| Multi-angle output         | Single multi-angle `master.m3u8`; angle/audio-only extraction moves client-side into `hls/` helpers (server-side split + audio-only playlist deleted)                                    |
| Testing contract           | A `cms-mock/` workspace mocks the Luminary CMS so the flow is testable before the contract is implemented in luminary itself                                                             |
| Follow-ups                 | Recorded in root `Todo.md`                                                                                                                                                               |

Execution strategy (also owner-approved): Opus 5 subagents implement phase by
phase; Fable 5 reviews each diff, runs builds, and steers corrections; the
owner commits manually; no tests written until manual verification.

## 4. Implementation phases (each an Opus 5 agent, reviewed before the next)

1. **Ingestion seam + tus removal** — extracted `IngestService.finalizeUpload`
   from the tus service; deleted tus, `saas/`, `admin/`, `tusd/`, their CI;
   root workspaces updated.
2. **Auth simplification** — deleted the SaaS key-validation/authorization
   webhook services; `AuthType` narrowed to `master | session`; master key
   injected via `LOCAL_API_TOKEN` provider (env fallback `MASTER_API_KEY`).
3. **Webhook removal** — SSE + polling only; queue positions now emitted over
   SSE; `SessionStatus` moved to its own module; restart-notifier deleted.
4. **Encryption** — `generateKey() = randomBytes(16)`; `HLS_ENCRYPTION_SEED`
   gone; `keyUrl` optional with `luminary://key` default; key/IV generated
   before the `encoding` status flip.
5. **Single multi-angle master** — server-side per-angle split and audio-only
   playlist deleted; new `hls/src/angles.ts` helpers (`listVideoAngles`,
   `extractAnglePlaylist`, `extractAudioOnlyPlaylist`); `HlsPlayer.vue`
   composes extract → key-swap via blob URLs; hls lib gained an ESM build.
6. **CMS/LNA endpoint + ingest + list + mock** — PNA preflight middleware;
   origin registry with TOFU approver seam; `POST /api/cms/sessions` with
   `documentId` idempotency and per-session prefix; read tokens (`read_*`)
   for SSE/status only; `hlsUrl` + `encryptionKeyHex` emitted at encode
   start; `POST /api/sessions/:id/local-file` ingests by reference (audited:
   nothing ever unlinks the user's file); session list endpoint;
   session-scoped chapter routes; terminal sessions purged on boot;
   `cms-mock/` workspace built in parallel.
7. **Credential protection** — `CREDENTIAL_CIPHER` seam; `session.json`
   always redacted; `credentials.enc` sidecar only when a cipher exists;
   restore marks unrecoverable sessions failed with a clear message; egress
   audit found no leaks; retry/chapters guarded against redacted creds.
8. **App cleanup** — Auth0/PWA/Cloudflare and all SaaS views removed;
   `api.ts` rewritten against the local API with the preload-bridge token;
   new `ActiveSessionsView`; `SessionView` rewired (local session load,
   path-based file selection, chapters via session routes, single waveform
   endpoint, playback from reported `hlsUrl`).
9. **Electron shell + packaging** — `createServer(opts)` bootstrap via a
   dynamic `RuntimeOptionsModule`; ffmpeg/ffprobe resolution via
   `FFMPEG_PATH`/`FFPROBE_PATH` (16 call sites swept); `electron/` workspace
   (safeStorage cipher, queued TOFU dialogs with Block as default,
   protocol handler, single instance, graceful shutdown); packaged mac
   `.app` built and verified to boot the server and serve the UI. Notable
   finding: the "Nest under asar" risk was actually an electron-builder 25
   hoisted-dependency collection bug — fixed by upgrading to 26; also
   `npmRebuild: false` required.
10. **Docs** — `CLAUDE.md`, root/api/app READMEs rewritten; `Todo.md`
    follow-up ledger created; `privacy-review.md` marked as predating the
    migration.

## 5. Supervision notes (issues caught/handled during review)

- Verified `cleanupSessionFiles` and all purge paths only touch
  `WORK_DIR/<id>` before approving ingest-by-reference.
- Confirmed SSE `emitEvent` and every response DTO exclude S3 config; read
  tokens only reach the status GET.
- Confirmed key/IV generation ordering ahead of the encode-start event.
- The TOFU dialog queue was reviewed for re-entrancy (sequential, re-checked
  after waiting, Block as default/cancel).
- Test suites were left intentionally red per the owner's
  tests-after-manual-verification preference; measured state recorded in
  `Todo.md`.

## 6. Outcome

Seven logical commits pushed to
`154-migrate-luminary-media-convert-to-a-local-only-electron-app-remove-saas-features`:
SaaS removal → hls lib → api → app → cms-mock → electron → docs. All
workspaces build; a packaged macOS app boots the embedded API. The manual
end-to-end verification checklist, CMS-side integration work, and deferred
features are in `Todo.md` (item 0 onward).
