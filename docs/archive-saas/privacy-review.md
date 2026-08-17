# Privacy Review — Luminary Media Convert

> **Note (2026-08-05):** This audit predates the local-only migration. It describes a multi-tenant SaaS product — the `saas/`, `admin/` and `tusd/` workspaces, CouchDB, Auth0 and webhook delivery — none of which exists any more. It is kept as a dated snapshot; the findings below should not be read as describing current behaviour. A fresh review against the local-only architecture is tracked in [`Todo.md`](Todo.md).

**Date:** 2026-03-21
**Scope:** Complete codebase — API, SaaS Service, Web Client, Admin Panel, Encode Config, Tusd Wrapper
**Frameworks:** GDPR (EU), CCPA/CPRA (California), VCDPA (Virginia), CPA (Colorado), CTDPA (Connecticut), state-level US privacy laws

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Personal Data Inventory](#2-personal-data-inventory)
3. [Data Flow Analysis](#3-data-flow-analysis)
4. [GDPR Compliance Assessment](#4-gdpr-compliance-assessment)
5. [US Privacy Law Compliance Assessment](#5-us-privacy-law-compliance-assessment)
6. [Encryption & Security Controls](#6-encryption--security-controls)
7. [Data Retention & Deletion](#7-data-retention--deletion)
8. [Third-Party Data Sharing](#8-third-party-data-sharing)
9. [Logging & PII Exposure](#9-logging--pii-exposure)
10. [Client-Side Privacy](#10-client-side-privacy)
11. [Findings Summary](#11-findings-summary)
12. [Recommendations](#12-recommendations)

---

## 1. Executive Summary

Luminary Media Convert is a multi-tenant media encoding SaaS platform. It collects limited personal data (email, name, Auth0 ID) and processes user-uploaded media files. The system demonstrates good security hygiene — S3 credentials are encrypted at rest, API keys are stored as hashes, sessions auto-expire, and no analytics/tracking is present.

**Key gaps identified:**
- No privacy policy, cookie notice, or consent mechanisms
- No data export (Subject Access Request / DSAR) endpoints
- No right-to-erasure cascade (user deletion doesn't remove related sessions/keys)
- HLS encryption keys stored unencrypted in CouchDB
- PII logged at DEBUG level (email, Auth0 subject ID)
- No audit trail for admin access to user data
- CORS defaults to `*` (all origins)
- Encryption key URL persisted in plain localStorage

---

## 2. Personal Data Inventory

### 2.1 Data Collected & Stored (CouchDB — SaaS Service)

| Data Element | Storage Location | Encrypted at Rest | Retention | Legal Basis (GDPR) |
|---|---|---|---|---|
| Email address | `users` collection | No | Indefinite | Legitimate interest / Contract |
| Display name | `users` collection | No | Indefinite | Contract |
| Auth0 subject ID | `users` collection | No | Indefinite | Contract |
| User role (user/admin) | `users` collection | No | Indefinite | Contract |
| Account status | `users` collection | No | Indefinite | Contract |
| Last login timestamp | `users` collection | No | Indefinite | Legitimate interest |
| Last API access timestamp | `users` collection | No | Indefinite | Legitimate interest |
| Invited-by reference | `users` collection | No | Indefinite | Legitimate interest |
| Email verified timestamp | `users` collection | No | Indefinite | Legitimate interest |
| Onboarding completed timestamp | `users` collection | No | Indefinite | Legitimate interest |
| API key hash (SHA-256) | `apikeys` collection | No (hashed) | Until revoked | Contract |
| API key prefix (12 chars) | `apikeys` collection | No | Until revoked | Contract |
| API key last-used timestamp | `apikeys` collection | No | Until revoked | Legitimate interest |
| S3 access key | `s3configs` collection | **Yes** (AES-256-GCM) | Until deleted | Contract |
| S3 secret key | `s3configs` collection | **Yes** (AES-256-GCM) | Until deleted | Contract |
| S3 endpoint/bucket/region | `s3configs` collection | No | Until deleted | Contract |
| Session name | `sessions` collection | No | 30 days (configurable) | Contract |
| Session status/progress | `sessions` collection | No | 30 days | Contract |
| Media probe results | `sessions` collection | No | 30 days | Contract |
| HLS encryption key (hex) | `sessions` collection | **No** | 30 days | Contract |
| S3 output file paths | `sessions` collection | No | 30 days | Contract |

### 2.2 Data Collected & Stored (In-Memory — Encoding API)

| Data Element | Storage | Retention |
|---|---|---|
| S3 credentials (from request) | In-memory `Map` | Session lifetime (max 24h) |
| Webhook URL | In-memory `Map` | Session lifetime |
| Upload token (`sess_*`) | In-memory `Map` | Session lifetime |
| Media file (temporary) | Filesystem (`WORK_DIR`) | Deleted after encoding |
| Encoded output (temporary) | Filesystem (`WORK_DIR`) | Deleted after S3 upload |

### 2.3 Data Collected & Stored (Browser — Client Apps)

| Data Element | Storage | Retention |
|---|---|---|
| Auth0 session/tokens | Auth0 SDK (memory/cookie) | Session duration |
| Encoding config preferences | `localStorage` (`luminary_encode_configs`) | Indefinite |
| Byte-range preference | `localStorage` (`luminary_byte_range`) | Indefinite |
| Encryption enabled flag | `localStorage` (`luminary_encryption_enabled`) | Indefinite |
| Encryption key URL | `localStorage` (`luminary_encryption_key_url`) | Indefinite |
| Selected S3 config ID | `localStorage` (`luminary_selected_s3_config`) | Indefinite |
| Path prefix | `localStorage` (`luminary_path_prefix`) | Indefinite |
| Thumbnail preference | `localStorage` (`luminary_thumbnails`) | Indefinite |

### 2.4 Data NOT Collected

- IP addresses (no logging)
- Browser user agent strings
- Device fingerprints
- Cookies (application-level — Auth0 may set its own)
- Analytics / telemetry
- Geolocation
- Advertising identifiers

---

## 3. Data Flow Analysis

```
User Browser
  │
  ├─► Auth0 (OAuth2/OIDC login)
  │     Returns: JWT with sub, email, profile
  │
  ├─► SaaS Service (/saas/*)
  │     Sends: Auth0 JWT, session configs, S3 configs, API key hashes
  │     Receives: User profile, session history, S3 configs (masked creds)
  │     Stores: User records, sessions, API keys, S3 configs → CouchDB
  │
  ├─► Encoding API (/api/*)
  │     Sends: API key or session token, S3 creds, media files, encode config
  │     Receives: Session status, probe results, SSE progress events
  │     Stores: In-memory sessions, temp files on disk
  │
  └─► S3 Storage (user-provided)
        Receives: Encoded HLS output files
        Client controls: endpoint, bucket, credentials

Encoding API ──webhook──► SaaS Service
  Sends: Session status, progress, file list, encryption key hex
  Auth: X-Session-Token header (WEBHOOK_SECRET)

Encoding API ──upload──► User's S3 Bucket
  Sends: Encoded media files
  Auth: User-provided S3 credentials

Encoding API ──optional──► Key Validation Webhook (external)
  Sends: { apiKey }
  Receives: { valid, metadata }

Encoding API ──optional──► Authorization Webhook (external)
  Sends: { action, userId, sessionId, metadata }
  Receives: { allowed, reason }
```

---

## 4. GDPR Compliance Assessment

### 4.1 Lawful Basis for Processing (Article 6)

| Processing Activity | Claimed Basis | Assessment |
|---|---|---|
| User account storage | Contract performance | **Adequate** — needed to provide the service |
| Media encoding | Contract performance | **Adequate** — core service function |
| Login/access timestamps | Legitimate interest | **Needs documentation** — no LIA (Legitimate Interest Assessment) found |
| Webhook delivery to external URLs | Contract performance | **Adequate** — user-configured |
| Session retention (30 days) | Legitimate interest | **Needs documentation** — should be justified and configurable |

### 4.2 Data Subject Rights

| Right | Status | Details |
|---|---|---|
| **Right of Access (Art. 15)** | ❌ Not implemented | No data export endpoint. Users can view their sessions and keys in UI but cannot export all personal data in machine-readable format |
| **Right to Rectification (Art. 16)** | ⚠️ Partial | Users can update session names. Admin can update user name/role. No self-service profile editing |
| **Right to Erasure (Art. 17)** | ⚠️ Partial | Users can delete individual sessions (with optional S3 file cleanup). Admin can delete users. **No cascade**: deleting a user does NOT delete their sessions, API keys, or S3 configs |
| **Right to Restriction (Art. 18)** | ❌ Not implemented | No mechanism to restrict processing while keeping data |
| **Right to Data Portability (Art. 20)** | ❌ Not implemented | No structured data export in machine-readable format |
| **Right to Object (Art. 21)** | ⚠️ Partial | Users can revoke API keys and delete sessions. No mechanism to object to specific processing activities |
| **Right re: Automated Decision-Making (Art. 22)** | ✅ N/A | No automated decision-making or profiling |

### 4.3 Data Protection by Design & Default (Article 25)

| Principle | Status | Details |
|---|---|---|
| Data minimization | ✅ Good | Only essential data collected; no tracking/analytics |
| Purpose limitation | ✅ Good | Data used only for encoding service delivery |
| Storage limitation | ⚠️ Partial | Sessions auto-expire (30d). Users and API keys retained indefinitely |
| Integrity & confidentiality | ⚠️ Partial | S3 creds encrypted, API keys hashed. HLS encryption keys stored in plaintext |
| Pseudonymization | ⚠️ Partial | Internal UUIDs used for sessions. User records contain email in plaintext |

### 4.4 Data Processing Agreement Requirements (Article 28)

- **Auth0**: Acts as data processor for authentication. DPA required.
- **S3 providers**: User-selected. Platform should document that users are responsible for their own S3 provider DPAs.
- **CouchDB hosting**: If hosted externally, DPA required with hosting provider.

### 4.5 Data Breach Notification (Articles 33-34)

- ❌ No breach detection mechanisms in code
- ❌ No breach notification workflow
- ❌ No audit logging to support breach investigation
- The 72-hour notification requirement to supervisory authorities would be difficult to meet without audit infrastructure

### 4.6 Data Protection Impact Assessment (Article 35)

- ⚠️ A DPIA should be considered given:
  - Processing of authentication data at scale
  - Storage of third-party credentials (S3 keys)
  - Multi-tenant architecture where data isolation failures could expose cross-tenant data

### 4.7 International Data Transfers (Chapter V)

- Auth0 servers may be located outside the EU (depends on tenant configuration)
- S3 storage location is user-controlled
- CouchDB location depends on deployment
- ❌ No Standard Contractual Clauses (SCCs) or transfer mechanisms documented

---

## 5. US Privacy Law Compliance Assessment

### 5.1 CCPA/CPRA (California)

| Requirement | Status | Details |
|---|---|---|
| Right to Know | ❌ Not implemented | No mechanism for consumers to request disclosure of collected data |
| Right to Delete | ⚠️ Partial | Session deletion exists; no comprehensive account deletion with cascade |
| Right to Opt-Out of Sale | ✅ N/A | No data sale occurs |
| Right to Non-Discrimination | ✅ N/A | No tiered service based on privacy choices |
| Right to Correct | ⚠️ Partial | Limited editing capabilities |
| Right to Limit Use of Sensitive PI | ⚠️ Unclear | S3 credentials could be considered sensitive PI; encryption is good |
| Privacy Notice at Collection | ❌ Missing | No privacy notice displayed at or before data collection |
| Data Retention Disclosure | ❌ Missing | Retention periods not communicated to users |
| Service Provider Agreements | ⚠️ Needed | Required for Auth0, hosting providers |

**CCPA Applicability Note:** CCPA applies if the business meets revenue/data thresholds. Even if not currently applicable, implementing these controls is best practice.

### 5.2 Virginia VCDPA / Colorado CPA / Connecticut CTDPA

These laws share similar requirements:

| Requirement | Status |
|---|---|
| Privacy notice | ❌ Missing |
| Right to access | ❌ Not implemented |
| Right to delete | ⚠️ Partial |
| Right to data portability | ❌ Not implemented |
| Right to opt out of targeted advertising | ✅ N/A (no advertising) |
| Right to opt out of profiling | ✅ N/A (no profiling) |
| Right to appeal | ❌ Not implemented |
| Data protection assessments | ❌ Not documented |
| Consent for sensitive data | ⚠️ No explicit consent mechanism |

### 5.3 Children's Privacy (COPPA)

- No age verification or gate
- No specific COPPA compliance measures
- **Risk**: If any users are under 13, COPPA obligations apply
- **Recommendation**: Add age verification or terms requiring users to be 13+/16+/18+

---

## 6. Encryption & Security Controls

### 6.1 Encryption at Rest

| Data | Method | Key Management | Assessment |
|---|---|---|---|
| S3 credentials | AES-256-GCM | `S3_ENCRYPTION_KEY` env var (64 hex chars) | ✅ Good — unique IV per field, auth tags |
| API keys | SHA-256 hash | N/A (one-way) | ✅ Good — irreversible |
| HLS encryption keys | **Plaintext** | N/A | ❌ **Gap** — stored as `encryptionKeyHex` in CouchDB |
| User PII (email, name) | **Plaintext** | N/A | ⚠️ Consider encryption |
| Session data | **Plaintext** | N/A | ⚠️ Acceptable if CouchDB access controlled |
| Media files (temp) | **Plaintext** on disk | N/A | ⚠️ Acceptable — short-lived, auto-deleted |

### 6.2 Encryption in Transit

| Channel | Status |
|---|---|
| Browser ↔ SaaS Service | HTTPS (depends on deployment) |
| Browser ↔ Encoding API | HTTPS (depends on deployment) |
| Encoding API ↔ S3 | `useSSL` configurable (defaults to true) |
| Encoding API ↔ Webhook endpoints | No TLS enforcement in code |
| SaaS Service ↔ CouchDB | Depends on `COUCHDB_URL` scheme |

### 6.3 Key Management Gaps

- **No key rotation** for S3 encryption master key — re-encrypting all credentials on rotation not supported
- **No key versioning** — can't migrate encrypted data during rotation
- **Deterministic HLS key derivation** — `HMAC-SHA256(seed, sessionId)` means compromising `HLS_ENCRYPTION_SEED` compromises all past and future keys
- **Single master key** for all S3 credential encryption across all tenants

### 6.4 Authentication Security

| Mechanism | Assessment |
|---|---|
| Auth0 JWT (RS256 + JWKS) | ✅ Industry standard |
| API key validation (external webhook) | ✅ Good separation of concerns |
| Session tokens (`sess_*` UUID) | ✅ Sufficient entropy |
| Tus upload bearer auth | ✅ Per-session tokens |
| Webhook secret (`WEBHOOK_SECRET`) | ⚠️ Optional — logs warning if missing but accepts all webhooks |
| CORS | ⚠️ Defaults to `*` — must restrict in production |

---

## 7. Data Retention & Deletion

### 7.1 Automated Retention

| Data Type | Retention Period | Mechanism |
|---|---|---|
| Encoding sessions (CouchDB) | 30 days after completion (configurable via `SESSION_RETENTION_DAYS`) | Cron job (`SessionCleanupService`, daily at 3 AM) |
| In-memory sessions (API) | 24 hours after completion | `SessionService.cleanup()` |
| Temporary media files | Deleted after encoding | `EncodeService.cleanupSessionFiles()` |
| Incomplete tus uploads | 10 minutes | `TusUploadService.cleanUpExpiredUploads()` |

### 7.2 Manual Deletion

| Data Type | Available To | Cascade |
|---|---|---|
| Sessions | User (own), Admin (all) | Optional S3 file deletion via `?deleteFiles=true` |
| Users | Admin only | ❌ **No cascade** — orphaned sessions, keys, S3 configs remain |
| API keys | User (own, soft-delete/revoke), Admin | Document retained with `revoked` status |
| S3 configs | User (own) | Hard delete — does not delete S3 objects |

### 7.3 Retention Gaps

- **User records**: No expiration — retained indefinitely after account creation
- **Revoked API keys**: Never deleted — retained as audit trail indefinitely
- **S3 configs**: No expiration — retained until user manually deletes
- **CouchDB soft-delete**: `_deleted: true` documents may remain in CouchDB until compaction
- **No user-initiated full account deletion**: Users cannot delete their own account
- **No automated inactive-account cleanup**: Dormant accounts persist forever

---

## 8. Third-Party Data Sharing

### 8.1 Data Processors

| Third Party | Data Shared | Purpose | DPA Needed |
|---|---|---|---|
| **Auth0** | Email, name, auth tokens | Authentication | Yes |
| **CouchDB host** (if external) | All CouchDB data | Database storage | Yes |
| **S3 provider** (user-selected) | Encoded media files | File storage | User's responsibility |

### 8.2 Data Recipients (User-Configured)

| Recipient | Data Shared | Trigger |
|---|---|---|
| Webhook URL (per-session) | Session status, progress, file list, encryption key hex | Encoding status changes |
| Key validation webhook | API key (full key) | API key authentication |
| Authorization webhook | userId, sessionId, action, metadata | Session creation / encode start |

### 8.3 No Data Sale or Advertising

- No data is sold to third parties
- No advertising networks integrated
- No analytics or tracking services
- No data broker relationships

---

## 9. Logging & PII Exposure

### 9.1 PII in Logs

| Log Level | Data Logged | File | Risk |
|---|---|---|---|
| DEBUG | `sub=${auth0Id}, email=${email}` | `saas/src/auth/identity.service.ts` | **Medium** — PII in logs |
| DEBUG | `findByEmail(${email})` | `saas/src/auth/identity.service.ts` | **Medium** — PII in logs |
| DEBUG | `Extracted sub=${sub}, email=${email}` | `saas/src/auth/jwt.strategy.ts` | **Medium** — PII in logs |
| LOG | `Linked auth0Id ${sub} to user ${userId}` | `saas/src/auth/identity.service.ts` | **Low** — pseudonymous IDs |
| DEBUG | FFmpeg command arguments (file paths) | `api/src/encode/services/ffmpeg.service.ts` | **Low** — no PII |

### 9.2 Safe Logging Practices

- ✅ API keys never logged (only prefix)
- ✅ S3 credentials never logged
- ✅ Session tokens never logged
- ✅ Webhook payloads not logged
- ✅ Request/response bodies not logged
- ✅ No IP address logging

### 9.3 Log Configuration

- SaaS Service enables ALL log levels by default: `['log', 'error', 'warn', 'debug', 'verbose']`
- **Recommendation**: Disable DEBUG/VERBOSE in production to prevent PII leakage
- No log rotation or retention policy in code

---

## 10. Client-Side Privacy

### 10.1 Browser Storage

- **localStorage** used for encoding preferences — no expiry, no encryption
- **Encryption key URL** stored in plain localStorage — sensitive data exposure risk
- No mechanism to clear all application data from browser
- Auth0 SDK manages its own token storage (secure by default)

### 10.2 Third-Party Resources

- ✅ No external CDN scripts
- ✅ No analytics scripts
- ✅ No advertising scripts
- ✅ No third-party fonts or stylesheets loaded externally
- ⚠️ Swagger UI iframe in API keys page loads from Encoding API endpoint

### 10.3 Upload Metadata

- Original filename sent as tus upload metadata
- File MIME type sent as tus upload metadata
- No filename anonymization before transmission

### 10.4 Session Token in URL

- SSE endpoint passes session token as query parameter: `?token=<sessionToken>`
- Query parameters may be logged by proxies, CDNs, or browser history
- **Recommendation**: Use header-based authentication for SSE if possible

---

## 11. Findings Summary

### Critical (Regulatory Risk)

| # | Finding | Affected Regulation |
|---|---|---|
| C1 | **No privacy policy or notice** — users not informed about data collection, processing purposes, retention, or rights | GDPR Art. 13-14, CCPA §1798.100, VCDPA §59.1-578 |
| C2 | **No data export / Subject Access Request endpoint** — cannot fulfill access requests within required timeframes | GDPR Art. 15, CCPA §1798.100, VCDPA §59.1-577 |
| C3 | **Incomplete right to erasure** — user deletion doesn't cascade to sessions, API keys, or S3 configs; users cannot self-delete accounts | GDPR Art. 17, CCPA §1798.105 |
| C4 | **No consent mechanism** — no explicit consent collected for data processing; no cookie/tracking notice (Auth0 may set cookies) | GDPR Art. 7, ePrivacy Directive |

### High

| # | Finding |
|---|---|
| H1 | **HLS encryption keys stored in plaintext** in CouchDB `sessions` collection (`encryptionKeyHex` field) |
| H2 | **No audit logging** — admin access to user data, session data, and key management operations not recorded |
| H3 | **CORS defaults to `*`** — allows any origin to make authenticated requests in default configuration |
| H4 | **Webhook authentication optional** — if `WEBHOOK_SECRET` not configured, all inbound webhooks accepted |
| H5 | **PII logged at DEBUG level** — email and Auth0 subject ID written to application logs |

### Medium

| # | Finding |
|---|---|
| M1 | **No encryption key rotation** mechanism for S3 credential master key or HLS encryption seed |
| M2 | **Encryption key URL in plain localStorage** — `luminary_encryption_key_url` persisted without encryption |
| M3 | **Session token in URL query string** for SSE — may be captured by proxies, logs, or browser history |
| M4 | **No data retention disclosure** — retention periods not communicated to users |
| M5 | **No inactive account cleanup** — dormant user accounts and revoked API keys retained indefinitely |
| M6 | **User auto-linking by email** — Auth0 ID linked to existing user by email match on first login; weak email verification could enable account takeover |
| M7 | **No age verification** — no COPPA/minimum-age gate |
| M8 | **Original filenames transmitted** — upload metadata includes user's original filename without anonymization |

### Low

| # | Finding |
|---|---|
| L1 | **No security headers** — missing `X-Frame-Options`, `X-Content-Type-Options`, `Content-Security-Policy`, `Strict-Transport-Security` on API responses |
| L2 | **S3 credentials visible in form inputs** — credential fields use text inputs during editing, not masked |
| L3 | **Authorization webhook fail-open default** — `AUTHORIZATION_FAIL_MODE` defaults to `'open'` (allow) on webhook failure |
| L4 | **CouchDB soft-delete** — `_deleted: true` documents may be recoverable until database compaction |
| L5 | **All log levels enabled by default** in SaaS Service |

---

## 12. Recommendations

### Immediate (Regulatory Compliance)

1. **Create and display a privacy policy** covering: data collected, processing purposes, legal basis, retention periods, data subject rights, third-party processors (Auth0, hosting), and contact information for data protection inquiries.

2. **Implement data export endpoint** (`GET /saas/me/export`) returning all user data in JSON format — user profile, sessions, API key metadata (not hashes), S3 config metadata (not credentials).

3. **Implement cascade deletion** — when a user account is deleted, also delete or anonymize: all sessions, API keys, S3 configs. Add a user-facing account deletion endpoint.

4. **Add consent mechanism** — at minimum, require acceptance of privacy policy/terms at signup. If operating in the EU, implement cookie consent for Auth0 cookies.

5. **Implement data retention for user records** — add configurable retention for inactive accounts and hard-delete revoked API keys after a retention period.

### Short-Term (Security Hardening)

6. **Encrypt HLS encryption keys** in CouchDB using the same AES-256-GCM approach used for S3 credentials.

7. **Add audit logging** for admin operations (user access, session viewing, key revocation, account enable/disable/delete).

8. **Restrict CORS** — change default from `*` to a required explicit configuration with no wildcard fallback.

9. **Require webhook secret** — make `WEBHOOK_SECRET` a required configuration (fail if not set).

10. **Disable DEBUG/VERBOSE logging in production** or redact PII from debug log messages.

11. **Add security headers** via middleware: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`.

### Medium-Term (Best Practices)

12. **Implement encryption key rotation** — add key versioning to `CryptoService` so encrypted credentials can be migrated when the master key changes.

13. **Encrypt sensitive localStorage values** or move to session-scoped storage that clears on logout.

14. **Move SSE token to header** or use a short-lived SSE-specific token to avoid credential exposure in URLs.

15. **Add age verification gate** (minimum age 13 for COPPA, 16 for GDPR) during onboarding.

16. **Anonymize upload filenames** or make filename transmission opt-in.

17. **Implement data breach notification workflow** — detection, assessment, 72-hour supervisory authority notification (GDPR), and user notification procedures.

18. **Document DPA requirements** — provide guidance on required Data Processing Agreements with Auth0, hosting providers, and user responsibility for S3 provider agreements.

19. **Implement right to restriction of processing** — allow users to freeze their account and halt processing while retaining data.

20. **Run CouchDB compaction** on a schedule to ensure soft-deleted documents are fully purged within retention periods.
