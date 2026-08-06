# Security Audit Report v1 — Luminary Media Convert

**Date:** 2026-03-21
**Auditor:** Automated review + manual verification
**Scope:** Full monorepo (`api/`, `saas/`, `app/`, `admin/`, `tusd/`, `encode-config/`)
**Baseline:** [security-review.md](security-review.md) (initial findings)

---

## Executive Summary

The initial security review identified 29 findings (5 Critical, 8 High, 9 Medium, 7 Low). All Critical, High, and applicable Medium issues have been remediated. Two Medium items were retained by design with documented justification. Low-severity items remain as accepted risk.

| Severity | Found | Fixed | By Design | Remaining |
|----------|-------|-------|-----------|-----------|
| Critical | 5 | 5 | 0 | 0 |
| High | 8 | 8 | 0 | 0 |
| Medium | 9 | 7 | 2 | 0 |
| Low | 7 | 0 | 0 | 7 |

---

## Remediated Findings

### Critical

#### C1. CouchDB Regex Injection — FIXED

**Original risk:** User-supplied search strings interpolated directly into `$regex` queries, enabling ReDoS and query manipulation.

**Remediation:** Added `escapeRegex()` function that escapes all regex special characters before interpolation.

| File | Lines | Change |
|------|-------|--------|
| `saas/src/users/users.service.ts` | 11-13, 99 | `escapeRegex()` applied to `opts.search` |
| `saas/src/sessions/sessions.service.ts` | 20-22, 378 | `escapeRegex()` applied to `opts.name` |

**Tests:** `users.service.spec.ts` — 2 tests for regex special chars and ReDoS patterns; `sessions.service.spec.ts` — 1 test for regex escaping in name filter.

---

#### C2. Webhook Secret Bypass When Unset — FIXED

**Original risk:** When `WEBHOOK_SECRET` was not configured, all webhooks were accepted without authentication.

**Remediation:** Changed to fail-closed — throws `UnauthorizedException` when `WEBHOOK_SECRET` is not set.

| File | Lines | Change |
|------|-------|--------|
| `saas/src/webhooks/webhooks.service.ts` | 43-48 | Rejects all webhooks when secret is unconfigured |

**Tests:** `webhooks.service.spec.ts` — 2 tests confirming rejection when secret is unset.

---

#### C3. Webhook Token Timing Attack — FIXED

**Original risk:** String `!==` comparison of webhook tokens vulnerable to timing attacks.

**Remediation:** Replaced with `crypto.timingSafeEqual()` with length pre-check.

| File | Lines | Change |
|------|-------|--------|
| `saas/src/webhooks/webhooks.service.ts` | 6, 49-55 | `timingSafeEqual(Buffer.from(token), Buffer.from(secret))` |

**Tests:** Existing tests cover valid/invalid token behavior.

---

#### C4. Path Traversal in Tus Upload Filename — FIXED

**Original risk:** Tus upload metadata filename used directly in `path.join()`, allowing directory traversal (e.g., `../../etc/passwd`).

**Remediation:** Filename sanitized with `path.basename()` before use.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/services/tus-upload.service.ts` | 8, 130 | `basename(rawFilename) \|\| 'input'` |

**Tests:** `tus-upload.service.spec.ts` — 2 tests for `../../etc/passwd` and `subdir/file.mp4` traversal attempts.

---

#### C5. CORS Wildcard Default — FIXED (Modified Approach)

**Original risk:** `CORS_ORIGIN` defaulted to `'*'`, allowing any website to make cross-origin requests.

**Remediation:** Changed to `origin: true` (reflect request origin) with `credentials: false`. This is appropriate for a public, token-authenticated API with no cookie-based auth — the same pattern used by Stripe, GitHub, and Cloudflare APIs. Tus protocol headers are explicitly listed in `allowedHeaders` and `exposedHeaders`.

| File | Lines | Change |
|------|-------|--------|
| `api/src/main.ts` | 85-111 | Dynamic origin reflection, `credentials: false`, tus headers allowed |
| `saas/src/main.ts` | 51-62 | Warning logged when `CORS_ORIGIN` unset, defaults to `localhost:5173` |

**Design rationale:** The Encoding API serves both first-party and third-party browser clients. Third-party clients authenticate via API keys (`X-API-Key`) and session tokens (`Bearer sess_*`) — no ambient credentials exist. Restricting origins would break legitimate third-party integrations without adding security value.

**Constraint:** `credentials: false` must never be changed to `true` without also restricting origins.

---

### High

#### H1. No Rate Limiting — FIXED

**Original risk:** No rate limiting on any endpoint, enabling brute-force and DoS attacks.

**Remediation:** Added `@nestjs/throttler` globally to both API and SaaS services with two tiers. SSE endpoints excluded via `@SkipThrottle()`.

| File | Lines | Change |
|------|-------|--------|
| `api/src/app.module.ts` | 2, 11-19 | `ThrottlerModule.forRoot()` — 20 req/s, 100 req/min |
| `saas/src/app.module.ts` | 3-4, 19-24, 37 | Same throttler config |
| `api/src/encode/encode.controller.ts` | 27, 222 | `@SkipThrottle()` on SSE endpoint |
| `saas/src/sessions/admin-sessions.controller.ts` | 12, 52 | `@SkipThrottle()` on SSE endpoint |

---

#### H2. SSRF via Webhook URL — FIXED

**Original risk:** Webhook URLs could target internal services, cloud metadata endpoints, and localhost.

**Remediation:** Block cloud metadata endpoints (`169.254.x.x`, IPv6 link-local) at both hostname and DNS-resolved IP level. Private IPs (localhost, 10.x, 192.168.x) are intentionally allowed — webhook URLs are provided by authenticated users, and blocking them breaks legitimate use cases (internal services, VPN-hosted endpoints, development).

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/services/webhook.service.ts` | 9-17, 36-51 | Cloud metadata blocklist + DNS resolution check |

**Tests:** `webhook.service.spec.ts` — 5 tests covering cloud metadata blocking, DNS resolution, and allowing localhost/private IPs.

---

#### H3. Missing File Type Validation on Upload — FIXED

**Original risk:** Any file type accepted via tus upload, expanding attack surface for FFmpeg processing.

**Remediation:** Added media file extension allowlist (23 video + audio formats) checked in the `onUploadCreate` hook. Returns HTTP 415 for unsupported types.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/services/tus-upload.service.ts` | 19-28, 111-116 | `ALLOWED_EXTENSIONS` set + `hasAllowedExtension()` check |

**Tests:** `tus-upload.service.spec.ts` — 3 tests for rejected extensions, allowed extensions, and missing filename.

---

#### H4. Authorization Webhook Fail-Open Default — FIXED

**Original risk:** Default fail mode was `'open'` — network errors allowed requests through.

**Remediation:** Changed default to `'closed'`. Can be overridden via `AUTHORIZATION_FAIL_MODE=open` for specific deployments.

| File | Lines | Change |
|------|-------|--------|
| `api/src/auth/authorization-webhook.service.ts` | 27-28, 47 | Default changed from `'open'` to `'closed'` |

**Tests:** `authorization-webhook.service.spec.ts` — 4 tests updated for fail-closed default behavior.

---

#### H5. Unsafe Binary Path Resolution (tusd) — FIXED

**Original risk:** `execSync('which tusd')` searched the system PATH, allowing a malicious binary to be executed.

**Remediation:** Removed system PATH fallback entirely. Resolution now only checks `TUSD_BINARY_PATH` env var and local `bin/tusd`.

| File | Lines | Change |
|------|-------|--------|
| `tusd/src/binary.ts` | 1, 16-37 | Removed `execSync` import and PATH lookup |

---

#### H6. Header Pass-Through in Tusd Proxy — FIXED

**Original risk:** All client headers forwarded to tusd without filtering, including hop-by-hop headers.

**Remediation:** Added `filterHeaders()` that strips hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `upgrade`). `transfer-encoding` is intentionally preserved because the proxy pipes raw request bodies — stripping it causes tusd to misread chunked uploads.

| File | Lines | Change |
|------|-------|--------|
| `tusd/src/proxy.ts` | 3-22, 38 | `HOP_BY_HOP_HEADERS` set + `filterHeaders()` function |

**Tests:** `proxy.spec.ts` — Integration test confirming hop-by-hop headers stripped and safe headers forwarded.

---

#### H7. Unvalidated Hook Server Payload — FIXED

**Original risk:** Hook type cast without runtime validation; nested properties accessed without null checks.

**Remediation:** Added structural validation before processing — rejects payloads missing `Type`, `Event.Upload`, or `Event.HTTPRequest` with HTTP 400.

| File | Lines | Change |
|------|-------|--------|
| `tusd/src/hook-server.ts` | 87-91 | Null-safe validation of required fields |

**Tests:** `hook-server.spec.ts` — 2 tests for missing required fields and missing Upload object.

---

#### H8. Master API Key Non-Constant-Time Comparison — FIXED

**Original risk:** Simple `===` comparison vulnerable to timing attacks.

**Remediation:** Replaced with `crypto.timingSafeEqual()` with length pre-check.

| File | Lines | Change |
|------|-------|--------|
| `api/src/auth/auth-resolver.guard.ts` | 8, 47-50 | `timingSafeEqual(Buffer.from(apiKeyHeader), Buffer.from(masterKey))` |

---

### Medium

#### M2. Deterministic Encryption Key Derivation — FIXED

**Original risk:** Key derivation used only `sessionId` as HMAC input — deterministic and dependent on a single seed.

**Remediation:** Added per-session random salt (16 bytes) concatenated with `sessionId` before HMAC. Salt generated in the service and passed to the worker thread.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/services/encryption.service.ts` | 14-27, 30-32, 51 | `deriveKey()` accepts salt; `generateSalt()` added |
| `api/src/encode/services/encryption.worker.ts` | 17, 25-34, 119 | Worker `deriveKey()` uses salt from service |

---

#### M3. No Content Security Policy Headers — FIXED

**Original risk:** No CSP or security headers configured, increasing XSS impact.

**Remediation:** Added `helmet` middleware with CSP directives to both API and SaaS services. Helmet is skipped for `/api/tus` routes (tusd manages its own headers).

| File | Lines | Change |
|------|-------|--------|
| `api/src/main.ts` | 4, 11-31 | Helmet with CSP, skipped for `/api/tus` |
| `saas/src/main.ts` | 4, 15-24 | Helmet with CSP |

---

#### M4. Missing Nested Validation on videoTrackNames — FIXED

**Original risk:** `videoTrackNames` array items had no validators — arbitrary objects, long strings, or special characters accepted.

**Remediation:** Added `VideoTrackNameDto` class with `@IsNumber`, `@IsString`, `@IsNotEmpty`, `@MaxLength(100)`, and applied `@ValidateNested({ each: true })`.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/dto/encode-config.dto.ts` | 121-134, 173-179 | `VideoTrackNameDto` + nested validation |

---

#### M5. S3 Port Number Validation Missing — FIXED

**Original risk:** No range validation on port number.

**Remediation:** Added `@Min(1) @Max(65535)` validators.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/dto/s3-config.dto.ts` | 8, 28-31 | `@Min(1) @Max(65535)` on port field |

---

#### M6. Pagination Total Count Bug — FIXED

**Original risk:** `total` was set to `result.docs.length` (current page count) instead of actual total.

**Remediation:** Added parallel count query using same selector with `fields: ['_id']` and no limit/skip.

| File | Lines | Change |
|------|-------|--------|
| `saas/src/users/users.service.ts` | 109-122 | Parallel count query |
| `saas/src/sessions/sessions.service.ts` | 384-399, 449-467 | Parallel count query (both user and admin endpoints) |

---

#### M7. Encryption Key URL in localStorage — FIXED

**Original risk:** `luminary_encryption_key_url` persisted in `localStorage`, surviving browser sessions.

**Remediation:** Moved to `sessionStorage` — cleared when the tab closes.

| File | Lines | Change |
|------|-------|--------|
| `app/src/components/SessionConfigForm.vue` | 110, 141 | `sessionStorage.getItem/setItem` |

---

#### M8. Upload Expiration Only on Shutdown — FIXED

**Original risk:** Incomplete upload cleanup only ran on `onModuleDestroy`, allowing disk exhaustion.

**Remediation:** Added 30-minute periodic cleanup interval, properly cleared on module destroy.

| File | Lines | Change |
|------|-------|--------|
| `api/src/encode/services/tus-upload.service.ts` | 36, 172-181, 189-192 | `setInterval` + `clearInterval` |

---

## Items Retained By Design

#### M1. SSE Token in URL Query Parameter

**Status:** Accepted risk — architecture limitation.

The SSE endpoint (`GET /api/sessions/:id/events?token=sess_*`) passes the session token as a query parameter because the browser `EventSource` API does not support custom headers. Alternatives (WebSocket, polling-only) would require significant architecture changes.

**Mitigations in place:**
- Session tokens are short-lived and scoped to a single session
- Tokens cannot be reused for write operations (SSE is read-only)
- `maxAge: 600` on CORS limits preflight cache exposure

---

#### M9. Encoding API URL Exposed to Clients

**Status:** By design — service discovery mechanism.

The `/saas/me` endpoint returns `encodingApiUrl` so the web client can discover the Encoding API endpoint for uploads, encoding, and SSE. This is an authenticated endpoint (Auth0 JWT required) serving configuration to known users.

---

## Remaining Low-Severity Items (Accepted Risk)

| ID | Finding | Rationale for Acceptance |
|----|---------|--------------------------|
| L1 | Encryption key in webhook payload | By design — client needs the key. Webhook URLs are user-controlled and HTTPS is recommended in documentation |
| L2 | Error messages reveal session existence | UUID randomness makes enumeration impractical |
| L3 | FFmpeg args logged in debug mode | Debug logging disabled in production by default |
| L4 | Silent fire-and-forget failures | Non-critical audit fields (`lastLoginAt`, `lastApiAccessAt`); failures logged as warnings |
| L5 | API key validation cache TTL (60s) | Acceptable window; revocation propagates within 1 minute |
| L6 | Auth0 client IDs in .env files | Client IDs are semi-public (visible in browser); `.env` files are gitignored |
| L7 | Session token format | UUID v4 provides sufficient entropy for session scope |

---

## Additional Security Measures Added

### CORS Architecture for Third-Party Clients

The Encoding API supports both first-party (SaaS web client) and third-party browser clients. CORS is configured to reflect any request origin (`origin: true`) with `credentials: false`. This is safe because:

- No cookies or ambient credentials are used
- Every request requires an explicit `X-API-Key` or `Authorization: Bearer sess_*` header
- `credentials: false` prevents the dangerous wildcard + credentials combination

Tus protocol headers (`Tus-Resumable`, `Upload-Length`, `Upload-Offset`, `Upload-Metadata`, `Upload-Defer-Length`, `Upload-Concat`) are explicitly listed in `allowedHeaders` and `exposedHeaders` to support resumable uploads from any origin.

### CORS Preflight Handling for Tus

The tusd Go binary manages its own CORS independently. `OPTIONS` requests bypass the auth hook in `TusdServer.handle()` so CORS preflight requests (which carry no credentials) can reach tusd for its CORS response headers. Helmet is also skipped for `/api/tus` routes to avoid header conflicts.

---

## Positive Security Posture

- Auth0 JWT validation with JWKS and RS256
- S3 credentials encrypted at rest with AES-256-GCM (SaaS service)
- `class-validator` with `whitelist` and `forbidNonWhitelisted` globally
- FFmpeg uses array-based `spawn()` (no shell injection)
- No XSS vectors — Vue templates auto-escape, no `v-html` usage
- No SQL injection risk (CouchDB via nano client)
- Graceful shutdown hooks across all services
- API key hashing with SHA-256 before storage
- Session ownership checks consistently enforced
- Admin endpoints guarded with role-based access control (`JwtAuthGuard` + `AdminGuard`)

---

## Test Coverage for Security Fixes

| Area | Tests Added | Total Suite |
|------|-------------|-------------|
| API (`api/`) | +13 | 321 passing |
| SaaS (`saas/`) | +4 | 240 passing |
| Tusd (`tusd/`) | +3 | 17 passing |

All tests pass as of audit date.
