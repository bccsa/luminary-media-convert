# Security Review — Luminary Media Convert

**Date:** 2026-03-21
**Scope:** Full monorepo (`api/`, `saas/`, `app/`, `admin/`, `tusd/`, `encode-config/`)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High     | 8 |
| Medium   | 9 |
| Low      | 7 |

---

## Critical

### C1. CouchDB Regex Injection (ReDoS / Query Injection)

**Files:**
- `saas/src/users/users.service.ts:96-97`
- `saas/src/sessions/sessions.service.ts:374`

User-supplied search parameters are interpolated directly into CouchDB `$regex` queries without escaping:

```typescript
selector['$or'] = [
    { email: { $regex: `(?i)${opts.search}` } },
    { name: { $regex: `(?i)${opts.search}` } },
];
```

An attacker can craft regex patterns causing catastrophic backtracking (ReDoS) or manipulate the query context.

**Remediation:** Escape regex special characters before interpolation, or use simple substring matching instead.

---

### C2. Webhook Secret Bypass When Unset

**Files:**
- `saas/src/webhooks/webhooks.service.ts:44-47`
- `saas/src/sessions/sessions.service.ts:64`

When `WEBHOOK_SECRET` is not configured, the webhook validation is completely bypassed:

```typescript
const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
    this.logger.warn('WEBHOOK_SECRET not configured — accepting all webhooks');
    return; // ALL WEBHOOKS ACCEPTED
}
```

An attacker can send arbitrary webhook payloads to update session status, inject encryption keys, or corrupt data.

**Remediation:** Fail closed — throw an error if `WEBHOOK_SECRET` is not set in production.

---

### C3. Webhook Token Timing Attack

**File:** `saas/src/webhooks/webhooks.service.ts:49`

```typescript
if (token !== secret) {
    throw new UnauthorizedException('Invalid webhook token');
}
```

String `!==` comparison is vulnerable to timing attacks. An attacker measuring response times can deduce the correct token character-by-character.

**Remediation:** Use `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))`.

---

### C4. Path Traversal in Tus Upload Filename

**File:** `api/src/encode/services/tus-upload.service.ts:109-121`

The filename from tus metadata is used directly in `path.join()`:

```typescript
const filename = upload.metadata?.filename || 'input';
const destPath = join(sessionDir, filename);
```

An attacker could submit `filename: "../../etc/passwd"` to write files outside the session directory.

**Remediation:** Sanitize the filename — strip path separators and `..` sequences, or use only `path.basename()`.

---

### C5. CORS Wildcard Default (API)

**File:** `api/src/main.ts:55-63`

When `CORS_ORIGIN` is not set, CORS defaults to `'*'`, allowing any website to make cross-origin requests:

```typescript
origin: corsOrigin ? /* parse */ : '*',
```

**Remediation:** Require explicit `CORS_ORIGIN` configuration; refuse to start without it in production.

---

## High

### H1. No Rate Limiting on Any Endpoint

**Affected:** All controllers across `api/` and `saas/`

No rate limiting exists on session creation, encoding, upload initiation, API key validation, or webhook ingestion. Enables brute-force attacks, resource exhaustion, and denial of service.

**Remediation:** Add `@nestjs/throttler` with per-endpoint and per-IP limits.

---

### H2. SSRF via Webhook URL

**File:** `api/src/encode/dto/webhook-config.dto.ts:11`

```typescript
@IsUrl({ require_tld: false })
```

Webhook URLs accept `http://localhost`, `http://127.0.0.1`, `http://169.254.169.254/` (cloud metadata), and internal network addresses. No validation against private IP ranges.

**Remediation:** Block private IPs (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16), require HTTPS, and resolve DNS before connecting to verify the resolved IP.

---

### H3. Missing File Type Validation on Upload

**File:** `api/src/encode/services/tus-upload.service.ts:102-146`

No validation that uploaded files are valid media. Any file type is accepted and later processed by FFmpeg.

**Remediation:** Validate magic bytes or run a lightweight probe before accepting the upload.

---

### H4. Authorization Webhook Fail-Open Default

**File:** `api/src/auth/authorization-webhook.service.ts:47`

```typescript
const failMode = process.env.AUTHORIZATION_FAIL_MODE || 'open';
```

Network failures cause the authorization webhook to allow requests by default.

**Remediation:** Change default to `'closed'`.

---

### H5. Unsafe Binary Path Resolution (tusd)

**File:** `tusd/src/binary.ts:35-45`

Falls back to `execSync('which tusd')` — a malicious `tusd` binary earlier in `PATH` could be executed with application privileges.

**Remediation:** Remove system PATH fallback; require explicit `TUSD_BINARY_PATH` or use only the bundled binary.

---

### H6. Header Pass-Through in Tusd Proxy

**File:** `tusd/src/proxy.ts:13`

All client headers are forwarded to tusd without filtering, including hop-by-hop headers (Connection, Transfer-Encoding) that could cause protocol confusion.

**Remediation:** Whitelist allowed headers explicitly; strip hop-by-hop headers.

---

### H7. Unvalidated Hook Server Payload (tusd)

**File:** `tusd/src/hook-server.ts:74-89`

Hook type is cast without runtime validation (`payload.Type as HookType`). Payload properties are accessed without null checks.

**Remediation:** Validate hook payload schema with zod or joi before processing.

---

### H8. Master API Key Non-Constant-Time Comparison

**File:** `api/src/auth/auth-resolver.guard.ts:44-48`

```typescript
if (masterKey && apiKeyHeader === masterKey) {
```

Simple string equality is vulnerable to timing attacks.

**Remediation:** Use `crypto.timingSafeEqual()`.

---

## Medium

### M1. SSE Token Exposed in URL Query Parameters

**Files:**
- `app/src/api.ts:169`
- `admin/src/api.ts:115`
- `api/src/encode/encode.controller.ts:221-247`

The SSE endpoint authenticates via a `token` query parameter instead of an Authorization header. Query parameters are visible in browser history, server logs, and Referer headers.

**Remediation:** Use an alternative transport (polling with Authorization header, or WebSocket with token in the initial handshake).

---

### M2. Encryption Key Derivation is Deterministic

**File:** `api/src/encode/services/encryption.service.ts:14-25`

Key derivation uses HMAC-SHA256 with sessionId — deterministic and dependent on a single seed. If the seed leaks, all keys are compromised.

**Remediation:** Add a random salt per session (stored alongside the session) to the HMAC input.

---

### M3. No Content Security Policy Headers

**Files:** `app/index.html`, `admin/index.html`

No CSP meta tags or server-level CSP headers configured. Increases impact of any future XSS vulnerability.

**Remediation:** Configure CSP headers at the serving layer: `default-src 'self'; script-src 'self'; connect-src 'self' https://*.auth0.com`.

---

### M4. Missing Nested Validation on videoTrackNames

**File:** `api/src/encode/dto/encode-config.dto.ts:152-161`

`videoTrackNames` array items have no nested validators — attackers can inject arbitrary objects, very long strings, or special characters.

**Remediation:** Add `@ValidateNested({ each: true })` with a proper DTO class for the array items.

---

### M5. S3 Port Number Validation Missing

**File:** `api/src/encode/dto/s3-config.dto.ts:26-29`

```typescript
@IsNumber()
@IsOptional()
port?: number;
```

No range validation. Should be `@Min(1) @Max(65535)`.

---

### M6. Pagination Total Count Bug

**Files:**
- `saas/src/users/users.service.ts:107`
- `saas/src/sessions/sessions.service.ts:385`

`total` is set to `result.docs.length` (current page count) instead of the actual total, breaking pagination.

---

### M7. Encryption Key URL Persisted to localStorage

**File:** `app/src/components/SessionConfigForm.vue:141`

The `luminary_encryption_key_url` value is stored in localStorage. An attacker with localStorage access (via XSS or physical access) can discover the encryption key endpoint.

**Remediation:** Use sessionStorage (cleared on tab close) or prompt on each session.

---

### M8. Upload Expiration Only on Shutdown

**File:** `tusd/src/server.ts:144-179`

Incomplete upload cleanup only runs on `onModuleDestroy`. Long-running servers accumulate orphaned uploads, enabling disk exhaustion.

**Remediation:** Schedule periodic cleanup (e.g., hourly via `@nestjs/schedule`).

---

### M9. Internal API URL Exposed to Clients

**File:** `saas/src/me/me.controller.ts:18`

```typescript
encodingApiUrl: process.env.ENCODING_API_URL || undefined,
```

Internal infrastructure URLs should not be sent to clients.

**Remediation:** Serve the public-facing URL instead of the internal environment variable.

---

## Low

### L1. Encryption Key Sent in Webhook Payload

**File:** `api/src/encode/services/encode.service.ts:220-222`

The encryption key hex is included in plaintext in webhook payloads. If the webhook endpoint or transport is compromised, the key is exposed.

**Remediation:** Ensure webhook URLs require HTTPS. Consider encrypting the key within the payload.

---

### L2. Error Messages Reveal Session Existence

**File:** `api/src/encode/encode.controller.ts:164-173`

`NotFoundException("Session {sessionId} not found")` confirms whether a session ID exists, enabling enumeration (low risk due to UUID randomness).

---

### L3. FFmpeg Arguments Logged in Debug Mode

**File:** `api/src/encode/services/ffmpeg.service.ts:647`

FFmpeg command arguments (including file paths) are logged at debug level. Ensure debug logging is disabled in production.

---

### L4. Silent Fire-and-Forget Failures

**Files:**
- `saas/src/auth/identity.service.ts:63-67`
- `saas/src/webhooks/webhooks.service.ts:198-204`

Operations like `lastLoginAt` and `lastAccessAt` updates swallow errors silently, creating audit trail gaps.

---

### L5. API Key Validation Cache TTL

**File:** `api/src/auth/key-validation-webhook.service.ts:25`

Validated API keys are cached for 60 seconds. A revoked key remains valid until cache expires.

**Remediation:** Reduce TTL to 10-30 seconds or implement cache invalidation.

---

### L6. Auth0 Client IDs in .env Files

**Files:** `app/.env`, `admin/.env`, `saas/.env`

Auth0 domain and client IDs are present in working-directory `.env` files. While client IDs are semi-public (visible in browser), they should not be committed to version control alongside other secrets.

---

### L7. Weak Session Token Format

**File:** `api/src/encode/services/session.service.ts:58-59`

```typescript
const sessionToken = `sess_${randomUUID().replace(/-/g, '')}`;
```

While UUID v4 is cryptographically random, consider using `crypto.randomBytes(32).toString('hex')` for higher entropy tokens.

---

## Positive Findings

- Auth0 JWT validation properly configured with JWKS and RS256
- S3 credentials encrypted at rest with AES-256-GCM in the SaaS service
- `class-validator` with `whitelist` and `forbidNonWhitelisted` enabled globally
- FFmpeg uses array-based `spawn()` (not shell string concatenation)
- No XSS vectors — Vue templates auto-escape, no `v-html` usage detected
- No SQL injection risk (CouchDB via nano client, no raw SQL)
- Graceful shutdown hooks properly implemented across services
- HLS client-side encryption implementation is well-designed (blob URL rewriting, proper cleanup)
- API key hashing with SHA-256 before storage
- Session ownership checks consistently applied in SaaS service
- Admin endpoints properly guarded with role-based access control

---

## Recommended Priorities

### Immediate (before production)
1. Fix path traversal in tus filename (C4)
2. Fix CouchDB regex injection (C1)
3. Use constant-time comparison for webhook tokens and master key (C3, H8)
4. Set explicit CORS origins, remove wildcard default (C5)
5. Require `WEBHOOK_SECRET` in production (C2)

### Short-term
6. Add rate limiting across all endpoints (H1)
7. Validate webhook URLs against SSRF (H2)
8. Change authorization webhook fail mode to closed (H4)
9. Add file type validation on upload (H3)
10. Remove system PATH fallback for tusd binary (H5)

### Medium-term
11. Add CSP headers (M3)
12. Add per-session salt to encryption key derivation (M2)
13. Schedule periodic upload cleanup (M8)
14. Add nested DTO validation for videoTrackNames (M4)
15. Implement security event audit logging
