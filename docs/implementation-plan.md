# Implementation Plan: SaaS Adaptation

**Document ID**: IMPL-SAAS-001
**Version**: 1.0
**Date**: 2026-03-16
**Source**: URS-SAAS-001, FDS-SAAS-001

---

## Principles

- Each phase delivers a **testable, end-to-end slice** — no phase is purely backend work with nothing to test from a user perspective
- Phases build on each other — each phase assumes the previous phase is complete and tested
- The existing Encoding API remains fully functional throughout — no regression to current users
- Each phase ends with a **test checklist** describing what an end user or tester can verify
- **100% test coverage** (line and branch) is maintained at all times — every phase includes unit tests with simulation mocks for external processes
- **Vitest** is the sole test framework across all workspaces

---

## Phase 1 — Encoding API: Key Validation Webhook & Session Tokens

**Goal**: The open-source Encoding API gains API key authentication via an external key validation webhook, the authorization webhook, and the renamed session token -- making it self-service for any client that has the master key or an API key validated by an external service.

**Depends on**: Nothing (standalone Encoding API changes)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 1.0 | Migrate `api/` and `tusd/` from Jest to Vitest. Update test config, replace `jest.*` with `vi.*` globals, verify existing tests pass with 100% coverage | 10.1 |
| 1.1 | Add `KeyValidationService`: calls `KEY_VALIDATION_WEBHOOK_URL` to validate API keys, caches results (configurable TTL, default 60s) | 4.1 |
| 1.2 | Add `KeyValidationGuard`: NestJS guard for non-master `X-API-Key` values, uses `KeyValidationService` | 4.1 |
| 1.3 | Implement auth resolution chain: `X-API-Key` (master key -> webhook-validated API key) -> `Bearer sess_*` | 3.1.4 |
| 1.4 | Rename `uploadToken` -> `sessionToken` (`sess_` prefix), extend scope to all per-session operations | 4.2 |
| 1.5 | Merge `SessionAuthGuard` and `PreviewAuthGuard` into unified `SessionTokenGuard` | 4.2 |
| 1.6 | Implement webhook URL resolution: per-session `dto.webhook` -> validated key `webhookUrl` -> none | 4.3 |
| 1.7 | Implement authorization webhook: resolve URL (from validated key metadata or global env var), call before session creation and encode start, fail-open/closed modes | 3.2 |
| 1.8 | Replace Encoding API JWT/OIDC auth with master key auth (`MASTER_API_KEY` env var). Remove all OIDC/Passport dependencies (`passport`, `passport-jwt`, `jwks-rsa`, `@nestjs/passport`). The master key is the superkey for all endpoints. | 3.1.1 |
| 1.9 | Add env vars: `MASTER_API_KEY`, `KEY_VALIDATION_WEBHOOK_URL`, `KEY_VALIDATION_WEBHOOK_TIMEOUT_MS`, `KEY_VALIDATION_CACHE_TTL_MS`, `AUTHORIZATION_WEBHOOK_URL`, `AUTHORIZATION_WEBHOOK_TIMEOUT_MS`, `AUTHORIZATION_WEBHOOK_FAIL_MODE` | 10.1 |
| 1.10 | Update Swagger/OpenAPI docs for all new and changed endpoints | -- |
| 1.11 | Unit tests for all Phase 1 code: key validation webhook, auth guards, session token, master key validation, authorization webhook. Simulation mocks for webhook HTTP calls. 100% coverage | 10.2 |

### Test Checklist

- [ ] **Master key auth works**: Configure `MASTER_API_KEY`. Create a session with the master key (`X-API-Key` header), upload, encode, poll, preview -- full encoding pipeline works with master key auth
- [ ] **Key validation webhook**: Configure `KEY_VALIDATION_WEBHOOK_URL` pointing to a mock server. Send a request with an API key. Verify the Encoding API calls the webhook with `{ "apiKey": "..." }` and uses the returned metadata
- [ ] **Key validation caching**: Send two requests with the same API key within the cache TTL. Verify only one webhook call is made
- [ ] **Key validation rejection**: Configure mock to return `{ "valid": false, "reason": "Revoked" }`. Verify 401 response
- [ ] **Standalone mode**: Do not configure `KEY_VALIDATION_WEBHOOK_URL`. Verify API key requests return 401 and only master key works
- [ ] **API key session flow**: Configure webhook to return valid metadata. Use the API key (`X-API-Key` header) to create a session, upload via tus, submit encode config, poll until completed -- full encoding pipeline works
- [ ] **Session token scope**: Create a session (master key or API key), receive `sessionToken` in response, use it to upload, poll, encode, and access preview endpoints. Verify it cannot create new sessions
- [ ] **Webhook URL from validated key**: Configure webhook to return `webhookUrl` in metadata. Create a session with that key, verify webhooks are sent to the URL from the key metadata
- [ ] **Per-session webhook override**: Create a session with an API key and include `webhook.url` in the request body. Verify webhooks go to the per-session URL, not the key's URL
- [ ] **Authorization webhook (allow)**: Configure `AUTHORIZATION_WEBHOOK_URL` pointing to a mock server that returns `{ "allowed": true }`. Verify sessions can be created and encoding can start
- [ ] **Authorization webhook (deny)**: Configure mock to return `{ "allowed": false, "reason": "Test denial" }`. Verify session creation returns 403 with the reason
- [ ] **Authorization webhook (fail-open)**: Stop the mock server. Verify session creation still works (with warning logged). Repeat with `AUTHORIZATION_WEBHOOK_FAIL_MODE=closed` and verify 403
- [ ] **Vitest migration**: All existing `api/` and `tusd/` tests pass under Vitest. No Jest dependencies remain
- [ ] **100% coverage**: `npm -w api test -- --coverage` and `npm -w tusd test -- --coverage` report 100% line and branch coverage
- [ ] **No regression**: Full test suite passes

---

## Phase 2 — SaaS Service: Foundation & User Management

**Goal**: The SaaS Service exists as a running NestJS service with CouchDB, user management, and the admin seed command. An admin can log in, create users, and manage them through the API. The admin panel SPA is scaffolded with basic views.

**Depends on**: Phase 1 (Encoding API has key validation webhook and session tokens)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 2.1 | Scaffold `saas/` NestJS workspace in monorepo | 5.1 |
| 2.2 | Implement CouchDB database module (`nano` client, connection, database creation) | 5.2.1 |
| 2.3 | Implement Mango index creation on startup | 5.2.1 |
| 2.4 | Implement Auth0 JWT validation + identity resolution (email matching, `auth0Id` linking, reject unrecognized) | 3.3.1 |
| 2.5 | Implement user document CRUD in `UsersService` | 5.1 |
| 2.6 | Implement `AdminGuard` (role check) | — |
| 2.7 | Implement admin user CRUD endpoints (`/saas/admin/users/*`: create, list, get, update, disable, enable, delete) | — |
| 2.8 | Implement CLI seed command (`npm -w saas run seed:admin`) | 5.7 |
| 2.9 | Scaffold `admin/` Vue 3 SPA workspace (Vite, Tailwind, Auth0, Vue Router) | 8.1 |
| 2.10 | Implement admin role gate in `App.vue` | 8.2 |
| 2.11 | Build admin views: user list (paginated, searchable), user detail, create/edit user form | 8.1 |
| 2.12 | Add root `package.json` workspace entry for `saas/` and `admin/` | — |
| 2.13 | Unit tests for all Phase 2 code: identity resolution, user CRUD, admin guard, CouchDB mocks. Component tests for admin panel views. 100% coverage | 10.2 |

### Test Checklist

- [ ] **Seed admin**: Run `npm -w saas run seed:admin --email admin@example.com --name "Admin"`. Verify CouchDB document created
- [ ] **Admin login**: Log in to admin panel with Auth0. Verify system matches email, links `auth0Id`, shows admin dashboard
- [ ] **Non-admin rejection**: Log in with a non-admin Auth0 account that has no user document. Verify 403 "Account not provisioned"
- [ ] **Create user**: In admin panel, create a user with email, name, role. Verify CouchDB document created
- [ ] **User login**: New user logs in to web app via Auth0. Verify system matches by email, links `auth0Id`, grants access
- [ ] **Disable user**: Admin disables a user. Verify the user receives 403 on next request
- [ ] **Re-enable user**: Admin re-enables the user. Verify access is restored
- [ ] **Delete user**: Admin deletes a user. Verify CouchDB document is removed, user can no longer log in
- [ ] **Admin API direct**: Use `curl` to call `/saas/admin/users` with admin JWT. Verify paginated user list. Call with non-admin JWT. Verify 403
- [ ] **SaaS Service standalone**: SaaS Service starts, connects to CouchDB, creates indexes, serves endpoints — independent of Encoding API
- [ ] **100% coverage**: `npm -w saas test -- --coverage` and `npm -w admin test -- --coverage` report 100% coverage

---

## Phase 3 — Webhook Pipeline & Session History

**Goal**: The SaaS Service receives webhooks from the Encoding API, maintains session history in CouchDB, and exposes session listing. The admin panel gains a session browser. Users can see their encoding history for the first time.

**Depends on**: Phase 1 (webhooks from Encoding API), Phase 2 (user management in SaaS Service)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 3.1 | Implement webhook receiver (`POST /saas/webhooks/encoding`): validate token, resolve user from API key metadata, upsert session document | 5.3.1 |
| 3.2 | Implement session document compaction on terminal status (completed/failed) | 5.3.2 |
| 3.3 | Implement authorization webhook handler (`POST /saas/webhooks/authorize`): user status check, plan limit check (permissive defaults) | 3.2.3 |
| 3.4 | Implement session listing endpoint (`GET /saas/sessions`: paginated, filterable by status, sorted by date) | — |
| 3.5 | Implement session detail endpoint (`GET /saas/sessions/:id`: active status from CouchDB, historical from compacted doc) | — |
| 3.6 | Implement session expiry cron job (configurable schedule, deletes expired docs) | 5.6 |
| 3.7 | Implement admin session browsing endpoints (`/saas/admin/sessions`, `/saas/admin/users/:id/sessions`) | — |
| 3.8 | Implement admin dashboard stats endpoint (`GET /saas/admin/dashboard`: user counts, active sessions, recent activity) | — |
| 3.9 | Add session list and session detail views to admin panel | — |
| 3.10 | Add admin dashboard view (user counts, queue depth, recent completions/failures) | — |
| 3.11 | Unit tests for all Phase 3 code: webhook processing, session compaction, authorization handler, session expiry, CouchDB simulation. 100% coverage | 10.2 |

### Test Checklist

- [ ] **End-to-end webhook flow**: Create an API key via SaaS Service (`POST /saas/keys` -- implemented in Phase 4, or use master key to create a session with `webhook.url` pointing to SaaS Service). Use the key or master key to create a session and encode a file on the Encoding API. Verify the SaaS Service receives webhooks and creates/updates a session document in CouchDB
- [ ] **Session history appears**: After encoding completes, call `GET /saas/sessions` with user JWT. Verify the completed session appears in the list with summary data
- [ ] **Session detail**: Call `GET /saas/sessions/:id`. Verify compacted summary, S3 file references, encryption key (if applicable), cost estimate, timestamps
- [ ] **Active session tracking**: While encoding is in progress, verify `GET /saas/sessions/:id` shows current status and progress (updated via webhooks)
- [ ] **Authorization webhook**: Configure the Encoding API to use the SaaS Service's `/saas/webhooks/authorize`. Create a session — verify it's allowed. Disable the user in admin panel — verify next session creation returns 403 with "Account disabled"
- [ ] **Session expiry**: Create a completed session, manually set `expiresAt` to the past. Trigger cleanup (`POST /saas/admin/sessions/cleanup`). Verify session is deleted
- [ ] **Admin session browser**: In admin panel, browse all sessions across users. Filter by user. View session details
- [ ] **Admin dashboard**: Verify dashboard shows correct user counts, active sessions, recent activity

---

## Phase 4 — API Key Management & S3 Configs

**Goal**: Users can generate API keys through the SaaS web app and manage saved S3 configurations. This is the phase where third-party service integration becomes fully functional through the SaaS platform.

**Depends on**: Phase 3 (webhook pipeline must be working for keys to be useful)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 4.1 | Implement SaaS key management endpoints (`POST/GET/DELETE /saas/keys`) -- SaaS generates keys directly, stores hashes in CouchDB | 5.4 |
| 4.2 | Implement SaaS key validation webhook endpoint (`POST /saas/webhooks/validate-key`) -- validates API keys, returns metadata | 5.4.2 |
| 4.3 | Implement SaaS session creation endpoint (`POST /saas/sessions`) -- creates session on Encoding API with master key, returns sessionToken to web app | -- |
| 4.4 | Implement S3 credential encryption (AES-256-GCM) | 9.2 |
| 4.5 | Implement S3 config CRUD endpoints (`/saas/s3-configs`) | -- |
| 4.6 | Update web app: add API key management page (create, list, copy key, revoke) | -- |
| 4.7 | Update web app: add S3 config management page (save, edit, delete, select for session creation) | -- |
| 4.8 | Update web app: session creation flow -- call SaaS Service to create session (gets sessionToken), use sessionToken for upload/encode/poll on Encoding API | 7.2 |
| 4.9 | Implement admin API key revocation for any user (`DELETE /saas/admin/users/:userId/keys/:keyId`) | -- |
| 4.10 | Add API key list and revocation to admin user detail view | -- |
| 4.11 | Unit tests for all Phase 4 code: key generation, key validation webhook, SaaS session creation, S3 credential encryption/decryption, S3 config CRUD, component tests for key management and S3 config UI. 100% coverage | 10.2 |

### Test Checklist

- [ ] **Create API key via web app**: Log in, navigate to API key management, create a new key. Verify the full key is displayed once. Verify it appears in the key list (prefix only)
- [ ] **Third-party integration flow**: Copy the API key. Use it from a separate client (e.g., `curl`) to create a session on the Encoding API, upload a file, encode, and poll. Verify the Encoding API validates the key via the SaaS webhook. Verify the session appears in the user's session history on the SaaS Service (via webhooks)
- [ ] **Session token delegation**: Create a session with the API key. Pass the session token to a different client. Verify the second client can upload and poll using only the session token
- [ ] **Web app session creation**: Log in to web app. Create a session. Verify the web app calls SaaS Service (not Encoding API directly). Verify sessionToken is returned. Verify upload/encode/poll work with sessionToken on Encoding API
- [ ] **S3 config management**: Save an S3 config via the web app. Verify credentials are encrypted in CouchDB. Edit the config. Delete a config
- [ ] **Session creation with saved S3 config**: Select a saved S3 config when creating a session in the web app. Verify encoding completes and S3 upload works
- [ ] **Revoke API key**: Revoke a key via the web app. Verify it is marked as revoked in CouchDB. Verify the Encoding API's validation cache expires and the key is rejected on next use
- [ ] **Admin key revocation**: Admin revokes a user's API key via admin panel. Verify the key stops working (after cache TTL)
- [ ] **Key validation webhook**: Create a key via SaaS Service. Use the key on the Encoding API. Verify the Encoding API calls `/saas/webhooks/validate-key`. Verify returned metadata includes `webhookUrl` and `authorizationUrl`. Verify both authorization and lifecycle webhooks fire correctly

---

## Phase 5 — Web App: Session History & Playback

**Goal**: The web app gains a full session history view with filtering, sorting, and video playback from S3. Users can browse past encodes and play them back directly.

**Depends on**: Phase 4 (S3 configs and session history)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 5.1 | Implement web app session history view (paginated list, filter by status, sort by date) | — |
| 5.2 | Implement session detail view (summary, S3 file list, cost estimate, timestamps) | — |
| 5.3 | Implement historical session playback: load master playlist from S3 using saved S3 config, play via Video.js player | — |
| 5.4 | Handle encrypted playback: if session has encryption key, configure Video.js to serve decryption key | — |
| 5.5 | Implement session import UI: form to enter master playlist key or S3 folder prefix, select S3 config, optional encryption key | — |
| 5.6 | Implement `POST /saas/sessions/import` endpoint (HLS playlist parsing, S3 scanning, session document creation) | 5.5 |
| 5.7 | Add `imported: true` badge to imported sessions in history view | — |
| 5.8 | Unit tests for all Phase 5 code: HLS master playlist parser, S3 folder scanning simulation, session import logic, history/playback components. 100% coverage | 10.2 |

### Test Checklist

- [ ] **Session history browsing**: After several encodes, open session history. Verify paginated list with correct summaries. Filter by status (completed, failed). Sort by date
- [ ] **Session detail**: Click a completed session. Verify summary (renditions, audio groups, duration, encoder, segment format), file list, timestamps, cost estimate
- [ ] **Video playback from history**: Click play on a completed session with unencrypted output. Verify Video.js player loads the master playlist from S3 and plays with quality selection
- [ ] **Encrypted playback**: Click play on a completed session with encrypted output. Verify player decrypts and plays correctly (encryption key from session history)
- [ ] **Session import (master playlist)**: Import a session by providing a master playlist S3 key. Verify the system parses the playlist, reconstructs the summary, and creates a session in history with `imported` badge
- [ ] **Session import (folder scan)**: Import by providing an S3 folder prefix. Verify the system discovers the master playlist, parses it, and creates the session
- [ ] **Import with encryption key**: Import an encrypted HLS output with the encryption key provided. Verify playback works on the imported session
- [ ] **Import without encryption key**: Import encrypted output without the key. Verify the session appears in history but playback is not available (S3 URLs and file list still visible)
- [ ] **Expired session re-import**: Let a session expire from history. Verify it disappears. Import it again from S3. Verify it reappears

---

## Phase 6 — Billing Interfaces & Cost Estimation

**Goal**: The cost estimation utility is available in the UI, usage metering is wired up (no-op), and plan limit interfaces are in place with permissive defaults. The admin panel gains discount and plan tier configuration. Everything is ready for a real payment gateway in a future release.

**Depends on**: Phase 5 (session history, web app infrastructure)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 6.1 | Implement `estimateEncodingCost()` shared utility in `encode-config` package | 6.2 |
| 6.2 | Add real-time cost estimation display to `EncodeConfigForm` (pixel-minutes, audio minutes, per-rendition breakdown, free tier eligibility) | — |
| 6.3 | Implement `POST /saas/sessions/estimate` endpoint | — |
| 6.4 | Implement billing account document CRUD (create on user creation, default `free` tier) | — |
| 6.5 | Implement `PermissivePlanLimitsService` (all checks return allowed) | 6.3 |
| 6.6 | Implement `NoOpUsageMeterService` (structured logging of usage events) | 6.4 |
| 6.7 | Wire usage metering into webhook receiver (log events on session creation, encode start, completion) | — |
| 6.8 | Wire authorization webhook handler to use `PlanLimitsService` (currently permissive, but plumbing is in place) | — |
| 6.9 | Add admin discount/plan configuration to user detail view (discount %, plan tier, free minutes override) | — |
| 6.10 | Implement `PATCH /saas/admin/users/:userId` to update billing fields (discount, plan tier, free minutes cap) | — |
| 6.11 | Add usage summary to web app account/settings page | — |
| 6.12 | Implement signup service interface (no-op, `isSignupEnabled() = false`) | — |
| 6.13 | Unit tests for all Phase 6 code: `estimateEncodingCost()`, billing document CRUD, usage meter logging, plan limits service, cost estimation UI components. 100% coverage | 10.2 |

### Test Checklist

- [ ] **Cost estimation in UI**: Open the encode config form. Add/remove renditions. Verify pixel-minutes and audio minutes update in real-time. Toggle renditions between encode and copy mode. Verify copy-mode shows 0 pixel-minutes. Verify free tier eligibility indicator
- [ ] **Cost estimation API**: Call `POST /saas/sessions/estimate` with an encode config. Verify response includes pixel-minutes breakdown matching the client-side calculation
- [ ] **Usage metering (logs)**: Encode a video. Check SaaS Service logs for `usage:session_created`, `usage:encoding_started`, `usage:encoding_completed` structured log entries with correct pixel-minutes
- [ ] **Billing account creation**: Create a new user via admin panel. Verify a billing account document is created with `free` tier and 0% discount
- [ ] **Admin discount configuration**: In admin panel, set a 15% discount for a user. Verify the billing document is updated. View the user's effective pricing
- [ ] **Admin plan tier change**: Change a user from `free` to `payg`. Verify billing document updated
- [ ] **Admin free minutes override**: Set a custom free minutes cap for a user (e.g., 120 min/month). Verify stored in billing document
- [ ] **Authorization still permissive**: Despite billing plumbing being in place, verify all encode operations still pass (permissive defaults). Free tier users can still re-encode video (enforcement comes with real billing implementation)
- [ ] **Account settings page**: In web app, open account settings. Verify usage summary shows session count, pixel-minutes, audio minutes for the current period

---

## Phase 7 — Open-Source Packaging & Documentation

**Goal**: The Encoding API is fully decoupled from SaaS code and documented for standalone use. Video.js plugins are extracted. Open-source packages are ready for independent publication.

**Depends on**: Phase 6 (all features complete)

### Tasks

| # | Task | FDS Ref |
|---|------|---------|
| 7.1 | Audit Encoding API for any SaaS dependencies — remove if found | — |
| 7.2 | Write Encoding API standalone usage documentation (README: setup, master key config, API key flow, webhook config, session lifecycle) | — |
| 7.3 | Extract Video.js plugins to `@luminary/video-player` package | — |
| 7.4 | Update `encode-config` package exports (add `estimateEncodingCost`, types) | — |
| 7.5 | Add LICENSE files: Apache 2.0 for `api/` and `encode-config/`, MIT for `video-player/` and `tusd/` | — |
| 7.6 | Add CHANGELOG and CONTRIBUTING docs for open-source packages | — |
| 7.7 | Verify each open-source package builds, tests, and runs independently outside the monorepo | — |
| 7.8 | Final coverage audit: all workspaces at 100%. CI pipeline enforces coverage thresholds | 10.1 |

### Test Checklist

- [ ] **Standalone Encoding API**: Clone only the `api/` package. Install dependencies. Configure `MASTER_API_KEY`. Start the server. Create a session with the master key, upload, encode, poll -- full pipeline works without any SaaS Service, CouchDB, or key validation webhook
- [ ] **Standalone encode-config**: Import `@luminary/encode-config` in a fresh Vue project. Render `EncodeConfigForm` with mock probe results. Verify it works. Call `estimateEncodingCost()`. Verify correct output
- [ ] **Standalone video-player**: Import `@luminary/video-player` in a fresh project. Register plugins with Video.js. Verify quality selector and thumbnail preview work with an HLS stream
- [ ] **Standalone node-tusd**: Import `node-tusd` in a fresh project. Start a `TusdServer`. Upload a file via tus protocol. Verify hooks fire correctly
- [ ] **No SaaS leakage**: `grep -r "saas\|couchdb\|billing\|admin" api/src/` returns no results (excluding comments/docs)
- [ ] **Full SaaS platform regression**: Run the full stack (Encoding API + SaaS Service + Web App + Admin Panel). Verify everything still works end-to-end after extraction

---

## Phase Summary

| Phase | Deliverable | Key User-Testable Outcome |
|-------|-------------|--------------------------|
| 1 | Encoding API: key validation webhook, session tokens, auth webhook | API keys validated via external webhook; master key for standalone use |
| 2 | SaaS Service + Admin Panel foundation | Admin can seed, log in, create/manage users; users can log in |
| 3 | Webhook pipeline + session history | Users see encoding history; admin sees dashboard and all sessions |
| 4 | API key management + S3 configs + SaaS session creation | Users create API keys (SaaS-managed), saved S3 configs; web app gets sessionTokens from SaaS; third-party integration works |
| 5 | Session history UI + playback + import | Users browse history, play back encoded videos from S3, import external content |
| 6 | Billing interfaces + cost estimation | Users see cost estimates before encoding; admin configures discounts and plan tiers |
| 7 | Open-source packaging | Encoding API, encode-config, video-player, and tusd run fully standalone |
