# User Requirements Specification: SaaS Adaptation

**Document ID**: URS-SAAS-001
**Version**: 1.0
**Date**: 2026-03-16
**Status**: Draft

---

## 1. Introduction

### 1.1 Purpose

This document specifies the requirements for adapting Luminary Media Convert from a single-tenant encoding service to a multi-tenant SaaS platform. The adaptation introduces user-scoped sessions, API key authentication for third-party integrations, persistent session history with configurable expiry, and foundational interfaces for future payment gateway integration.

### 1.2 Scope

**In scope:**

- Multi-user session ownership and isolation
- Admin panel for user management (manual user provisioning)
- API key generation and management for programmatic access
- Persistent session history with configurable expiry (30 days default)
- Payment gateway interfaces and abstractions (design only — not implemented)
- Automated user signup interfaces (design only — not implemented)
- Repository restructuring for open-source and closed-source separation

**Out of scope:**

- Payment gateway implementation
- Automated user signup implementation (self-service registration, email verification, onboarding flow)
- Horizontal scaling / distributed queue
- Multi-region deployment

### 1.3 Current State

The system currently operates as a single-tenant service with the following characteristics:

- **No user association**: Sessions are globally addressable by UUID with no ownership model. Any authenticated user can access any session by ID.
- **In-memory storage**: All session state lives in a `Map<string, Session>` — no persistence across restarts.
- **Single global queue**: One FIFO encoding queue shared across all users with one concurrent job.
- **JWT validation only**: JWT is validated but no user identifier is extracted or stored.
- **No API key concept**: All programmatic access requires JWT tokens.
- **No session history**: Completed sessions are garbage-collected after 24 hours.

---

## 2. Component Architecture & Licensing

### 2.1 System Architecture

The system consists of two independent services and two client SPAs:

```
┌──────────────────┐     ┌──────────────────┐
│   Web App (SPA)  │     │ Admin Panel (SPA) │
│   app/           │     │ admin/            │
└────────┬─────────┘     └────────┬──────────┘
         │                        │
         │  Direct access         │  User/billing
         │  via JWT               │  management
         │                        │
         │              ┌─────────┴───────────┐
         │              │   SaaS Service      │  ← Closed-source
         │              │   saas/             │     management layer
         │              │                     │     (users, billing,
         │              │                     │      history, CouchDB)
         │              └─────────┬───────────┘
         │                        │  Generates API keys via
         │                        │  Encoding API endpoint;
         │                        │  receives webhooks
         ▼                        ▼
         ┌─────────────────────────┐
         │   Encoding API          │  ← Open-source, self-service
         │   api/                  │     (FFmpeg, tus, S3, probing,
         │                         │      JWT + API key auth, webhooks)
         │                         │     Runs on GPU hardware
         └─────────────────────────┘
                    ▲
                    │  Direct access via API key
                    │
         ┌──────────┴──────────┐
         │  Third-Party        │
         │  Services           │
         └─────────────────────┘
```

**Encoding API** (open-source, self-service): Runs standalone on suitable hardware (GPU-equipped). Supports **two authentication methods**: JWT tokens and **API keys**. Both can create sessions and perform all session operations. JWT is additionally required for API key management (privileged). The API key system is a built-in open-source feature. Sessions are ephemeral in-memory. Webhooks deliver status updates to configured URLs (per API key or per session). Can be scaled by running multiple instances.

- **Web app users** authenticate to the Encoding API with their OIDC JWT directly — no API key needed. The web app passes the SaaS Service's webhook URL in the session's `webhook` config so the SaaS Service stays informed.
- **Third-party services** authenticate with an API key (obtained from the SaaS web app). Webhooks are bound to the API key's `webhookUrl`.
- Both paths produce the same result: a session token for upload/poll/encode/preview, and webhook callbacks to the SaaS Service for history/billing.

**SaaS Service** (closed-source management layer): Runs as its own NestJS service. Manages users, billing interfaces, and session history. **Does not proxy or orchestrate encoding sessions** — instead, it generates API keys on the Encoding API (via a JWT-authenticated endpoint) and provides them to users. The SaaS Service stays informed of all encoding activity via webhooks (bound to API keys or passed per-session by the web app). Stores persistent data in CouchDB. Acts as the backend for the admin panel SPA and provides user/billing context to the web app.

### 2.2 Open-Source Components

The following components are designed for eventual migration to independent open-source repositories:

| Component | Location | Future Package | License | Description |
|-----------|----------|----------------|---------|-------------|
| Encoding API | `api/` | `@luminary/encode-api` | Apache 2.0 | NestJS encoding service (FFmpeg, S3, webhooks, tus uploads, encryption, thumbnails, API key auth) — stateless, no user/history/billing awareness |
| Encode Config | `encode-config/` | `@luminary/encode-config` | Apache 2.0 | Vue 3 encoding configuration component, shared types, and `estimateEncodingCost()` utility |
| Video Player | `app/src/videojs-*` | `@luminary/video-player` | MIT | Video.js 8 HLS quality selector and thumbnail preview plugins |
| Tusd Wrapper | `tusd/` | `node-tusd` | MIT | Node.js wrapper for Go tusd binary (already separated) |

**Licensing**: Core encoding components (API, config) use **Apache 2.0** for patent protection in the codec/streaming domain. Utility packages (video player plugins, tusd wrapper) use **MIT** for simplicity and maximum adoption.

**Design constraint**: The Encoding API has zero dependency on SaaS code. It is a standalone service that can be used independently by anyone — authenticate with a JWT, create a session, upload, encode, and receive results via webhook. No user management, no history, no billing.

### 2.3 Closed-Source Components

| Component | Location | Description |
|-----------|----------|-------------|
| SaaS Service | `saas/` | NestJS service: user management, API key generation, session history, billing interfaces, signup interfaces |
| Web Application | `app/` | Vue 3 SaaS frontend (upload, encode config, progress, session history, API key management, settings) |
| Admin Panel | `admin/` | Vue 3 admin SPA (user management, session browsing, dashboard, system configuration) |

**Note**: The web app and admin panel are **separate SPAs** with independent builds and deployments. The admin panel can be hosted on a separate subdomain (e.g., `admin.luminary.io`) with stricter network-level access controls.

The **web app** talks to **two backends**:
- **Encoding API** (directly, via JWT) — for session creation, file upload, encode config submission, polling, and preview playback. This is the same interaction pattern a third-party service uses, but with JWT instead of API key.
- **SaaS Service** (via JWT) — for API key management, session history, S3 config management, account settings, and usage/billing information.

The **admin panel** talks only to the SaaS Service.

The web app currently contains the Video.js plugins which will be extracted.

### 2.4 Service Boundary & Communication

The SaaS Service's only direct interaction with the Encoding API is **API key management**:

| SaaS Service action | Encoding API call | Description |
|---------------------|-------------------|-------------|
| Create API key | `POST /api/keys` (JWT auth) | SaaS Service generates an API key on the Encoding API, configures the webhook URL to point back to itself |
| Revoke API key | `DELETE /api/keys/:id` (JWT auth) | SaaS Service revokes a key when user requests it or account is disabled |

All other interactions (session creation, upload, encoding, polling) happen **directly between the client and the Encoding API**, authenticated with the API key. The SaaS Service is never in the data path.

**Encoding API authentication** — two methods (both open-source features):

1. **JWT** (privileged): For API key management only. The SaaS Service authenticates with a service-level JWT (OIDC client credentials grant). Standalone users can also use JWT directly.
2. **API key** (standard): For all session operations. Third-party services and SaaS-managed users authenticate with an API key to create sessions, upload, encode, poll, and preview.

**Webhook URL resolution**: The Encoding API determines the webhook URL for a session from two sources (in priority order):

1. **Per-session** — `CreateSessionDto.webhook.url` (if provided). The SaaS web app uses this path: it passes the SaaS Service's webhook URL directly when creating a session with JWT auth.
2. **Per-API-key** — The `webhookUrl` bound to the API key (if the session was created with an API key). Third-party services use this path: the webhook URL is configured once at key creation time.

Both paths result in the SaaS Service receiving webhooks for all sessions created by its users, whether via the web app (JWT + per-session webhook) or via third-party services (API key + bound webhook).

**Webhook-driven state synchronization**: The Encoding API sends webhooks on every session status change to the URL bound to the API key that created the session:

| Status | Webhook payload includes |
|--------|------------------------|
| `uploading` | Upload progress |
| `uploaded` | Probe result summary |
| `queued` | Queue position |
| `encoding` | Encoding progress (%) |
| `encrypting` | Encryption progress (%) |
| `uploading_to_s3` | S3 upload progress (%) |
| `completed` | Files list, master playlist, angle playlists, thumbnails VTT, encryption key, segment format, encoder, encoding stats |
| `failed` | Error message |

The SaaS Service uses these webhooks to:
1. Create/update session documents in CouchDB (the SaaS Service learns about sessions through webhooks, not by creating them)
2. On completion: store the compacted summary (FR-3.4.4) with S3 output references and encryption key
3. Record usage/billing events (pixel-minutes, audio minutes)
4. Optionally forward webhooks to the user's own webhook URL (for third-party integrations that want their own callbacks)

---

## 3. Functional Requirements

### 3.1 User Identity & Session Ownership

#### FR-3.1.1 User Identity Extraction

The system shall extract the user's identity from the Auth0 JWT on every authenticated request and associate it with the request context. Auth0 is used purely for authentication — all authorization (roles, permissions, plan tier) is managed by the SaaS API's User documents.

**Identity resolution flow**:

1. Extract `sub` (Auth0 ID) and `email` claims from the JWT
2. Look up User document by `auth0Id` (fast path — CouchDB view)
3. If no match by `auth0Id`, fall back to lookup by `email`
4. If matched by email, populate the User document's `auth0Id` field for future fast-path lookups
5. If no User document matches, reject with `403 Forbidden` ("Account not provisioned — contact your administrator")
6. If the matched User has `status: disabled`, reject with `403 Forbidden` ("Account disabled")
7. Attach the User document (role, plan tier, status) to the request context

When `AUTH0_SIGNUP_MODE=auto` (future), step 5 shall instead delegate to the `SignupService` interface to auto-provision users on first login.

#### FR-3.1.2 Session Ownership

Every session shall be associated with the user who created it. The `userId` shall be stored as a mandatory field on the session record.

#### FR-3.1.3 Session Isolation

Users shall only be able to access, poll, encode, and delete their own sessions. Any request to a session owned by a different user shall return `403 Forbidden`.

#### FR-3.1.4 Multiple Concurrent Sessions

A user shall be able to create and manage multiple sessions concurrently. There is no hard limit on sessions per user in the initial release, but the system shall support configurable per-user session limits for future use.

#### FR-3.1.5 Session Listing

The system shall provide an endpoint to list all sessions belonging to the authenticated user, with support for:

- Pagination (cursor-based or offset/limit)
- Filtering by status (e.g., `completed`, `failed`, `encoding`)
- Sorting by creation date (ascending/descending)

**Endpoint**: `GET /api/sessions`

### 3.2 API Key Authentication

API keys are a **built-in feature of the open-source Encoding API**. The Encoding API manages its own key store (in-memory or pluggable). The SaaS Service uses the Encoding API's key management endpoints (JWT-authenticated) to create and revoke keys on behalf of its users.

#### FR-3.2.1 Encoding API Key Management Endpoints (Open Source)

The Encoding API shall expose JWT-authenticated endpoints for API key lifecycle management:

- `POST /api/keys` — Create an API key. Accepts: `name`, `webhookUrl` (optional), `authorizationUrl` (optional), `expiresAt` (optional), `metadata` (optional JSON — the SaaS Service stores its `userId` here). Returns the full key once.
- `GET /api/keys` — List keys (name, prefix, creation date, last used, expiry — never the full key)
- `DELETE /api/keys/:keyId` — Revoke a key immediately

These endpoints require JWT authentication. API keys cannot manage other API keys.

Each API key on the Encoding API shall:

- Be a cryptographically random string with a recognizable prefix (e.g., `lmc_...`)
- Have a user-defined name/label for identification
- Have an optional `webhookUrl` — all sessions created with this key automatically send webhooks to this URL
- Have an optional `authorizationUrl` — the Encoding API calls this URL before session creation and encode start to check authorization (see FR-3.2.4)
- Have optional `metadata` (opaque JSON passed back in webhooks and authorization requests — allows the SaaS Service to correlate keys to users)
- Have an optional expiry date
- Be stored as a hash (the plaintext is returned only once at creation)

#### FR-3.2.2 API Key Authentication on Encoding API

The Encoding API shall accept API keys for all session operations. API keys shall be passed via the `X-API-Key` header.

When an API key is used, the Encoding API creates the session and automatically configures the webhook URL from the key's `webhookUrl` field. The Encoding API has no concept of "users" — the key is simply a credential that authorizes session operations and determines where webhooks are sent.

#### FR-3.2.3 SaaS Service Key Management (Closed Source)

The SaaS Service provides user-facing API key management by proxying to the Encoding API's key endpoints:

- User requests a new API key via the web app or `POST /saas/keys`
- SaaS Service calls `POST /api/keys` on the Encoding API (JWT auth) with:
  - `webhookUrl` set to the SaaS Service's webhook receiver (`POST /saas/webhooks/encoding`)
  - `authorizationUrl` set to the SaaS Service's authorization endpoint (`POST /saas/webhooks/authorize`)
  - `metadata` set to `{ "userId": "<user-uuid>" }` (so the SaaS Service can map webhook/auth events to users)
- SaaS Service records the key reference in CouchDB (key ID, name, prefix, user association — never the full key)
- Returns the full API key to the user (displayed once — user copies it to their third-party service)

Users manage their keys via the SaaS Service:
- `GET /saas/keys` — List keys (reads from CouchDB)
- `DELETE /saas/keys/:keyId` — Revoke key (calls `DELETE /api/keys/:keyId` on the Encoding API + removes from CouchDB)

#### FR-3.2.4 Authorization Webhook (Open Source)

The Encoding API shall support an optional **authorization webhook** — an HTTP callback invoked before processing privileged operations. This allows an external system (e.g., the SaaS Service) to enforce authorization decisions without the Encoding API needing any awareness of users, plans, or billing.

**Configuration**: The authorization webhook URL is configured per API key (`authorizationUrl` field) or globally via environment variable (`AUTHORIZATION_WEBHOOK_URL`). Per-key configuration takes precedence. When no authorization URL is configured (standalone/open-source mode), all requests are allowed.

**Trigger points**: The Encoding API shall call the authorization webhook before:

| Operation | Endpoint | Payload includes |
|-----------|----------|-----------------|
| Session creation | `POST /api/sessions` | API key metadata, S3 config summary (bucket, endpoint — not credentials) |
| Encode start | `POST /api/sessions/:id/encode` | API key metadata, encode config, probe result summary, cost estimate |

**Authorization request** (POST to the configured URL):

```json
{
    "action": "create_session" | "start_encode",
    "apiKeyId": "<key-id>",
    "apiKeyMetadata": { "userId": "<user-uuid>" },
    "sessionId": "<session-id>",
    "encodeConfig": null,
    "costEstimate": null,
    "timestamp": "2026-03-16T10:00:00Z"
}
```

For `start_encode`, `encodeConfig` and `costEstimate` are populated.

**Authorization response**:

```json
{
    "allowed": true
}
```

Or:

```json
{
    "allowed": false,
    "reason": "Free tier does not include video re-encoding. Upgrade at https://luminary.io/pricing"
}
```

**Behavior**:
- If the webhook returns `allowed: true` (or HTTP 200 with no body), the operation proceeds
- If the webhook returns `allowed: false`, the Encoding API rejects the request with `403 Forbidden` and includes the `reason` in the error response
- If the webhook is unreachable or returns a server error (5xx), the Encoding API behavior is configurable: default **fail-open** (allow the request) with a logged warning, configurable to **fail-closed** via `AUTHORIZATION_WEBHOOK_FAIL_MODE=closed`
- The webhook must respond within 5 seconds (configurable via `AUTHORIZATION_WEBHOOK_TIMEOUT_MS`)

**JWT-authenticated requests**: When a session is created with JWT auth (web app flow), the authorization webhook is also called if a global `AUTHORIZATION_WEBHOOK_URL` is configured. The payload includes the JWT `sub` and `email` claims instead of API key metadata.

**SaaS Service implementation**: The SaaS Service exposes `POST /saas/webhooks/authorize` as the authorization endpoint. When called by the Encoding API, it:

1. Resolves the user from `apiKeyMetadata.userId` or JWT claims
2. Checks user account status (reject if `disabled`)
3. For `create_session`: checks `canCreateSession()` (plan limits)
4. For `start_encode`: checks `canStartEncode()` with the cost estimate (free tier restrictions, monthly minutes cap)
5. Returns `allowed: true/false` with a user-facing reason on denial

#### FR-3.2.5 API Key Scoping (Future)

The data model shall include a `scopes` field on API keys to support fine-grained permissions in the future (e.g., `sessions:create`, `sessions:read`, `encode:start`). Initially, all API keys have full access.

#### FR-3.2.6 Rate Limiting

API key requests on the Encoding API shall be subject to per-key rate limiting. Default: 100 requests per minute per key. Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) shall be included in responses.

### 3.3 Third-Party API Integration & Session Tokens

#### FR-3.3.1 Two-Tier Authentication Model

The system supports a two-tier model for third-party integration:

- **API key** (server-side): The third-party service authenticates **directly with the Encoding API** using an API key (obtained from the SaaS web app). The API key allows creating sessions, uploading, encoding, and polling. The third-party server should keep the API key secret.
- **Session token**: When a session is created on the Encoding API, a session token is returned. The third-party server can pass this scoped, single-session token to its own web application, allowing end users to interact with a specific session (upload, poll, preview) without the API key being exposed in the browser.

#### FR-3.3.2 Session Token

The session token is generated by the Encoding API on session creation. It is a cryptographically random, opaque string (e.g., `sess_<random>`). The session token:

- Is generated and validated entirely by the Encoding API
- Grants access to a single session by ID
- Is scoped to per-session operations: file upload (tus), status polling, encode submission, preview playback
- Cannot be used to create new sessions or manage API keys
- Has the same lifetime as the session (ephemeral — exists only while the session is active in-memory)

**Note**: This replaces the current `uploadToken` concept. The new `sessionToken` extends coverage to the full session lifecycle.

#### FR-3.3.3 Session Token Capabilities

A session token authorizes the following operations on the Encoding API for its associated session only:

| Operation | Encoding API Endpoint | Description |
|-----------|----------------------|-------------|
| File upload | `ALL /api/tus`, `/api/tus/*` | Resumable chunked upload via tus protocol |
| Poll status | `GET /api/sessions/:id` | Read session status, probe results, progress, completion data |
| Start encode | `POST /api/sessions/:id/encode` | Submit encoding configuration |
| Preview key | `GET /api/sessions/:id/preview/key` | Retrieve HLS encryption key |
| Preview playlist | `GET /api/sessions/:id/preview/*` | Retrieve rewritten HLS playlists |

A session token shall **not** authorize:

- `POST /api/sessions` — Creating new sessions (requires API key or JWT)
- `POST /api/keys`, `GET /api/keys`, `DELETE /api/keys/:id` — Key management (requires JWT)

#### FR-3.3.4 Third-Party Integration Flow

```
Third-Party                  Encoding API               Third-Party
Server                       (GPU hardware)             Web App
  │                                │                        │
  │ POST /api/sessions             │                        │
  │ (X-API-Key: <api_key>)         │                        │
  │ ──────────────────────────────►│                        │
  │                                │                        │
  │ { sessionId, sessionToken,     │                        │
  │   tusEndpoint, maxUploadSize } │                        │
  │ ◄──────────────────────────────│                        │
  │                                │                        │
  │   Pass sessionId + sessionToken + encodingApiUrl        │
  │ ────────────────────────────────────────────────────────►
  │                                │                        │
  │                                │ Upload via tus         │
  │                                │ (Bearer <sess_token>)  │
  │                                │◄───────────────────────│
  │                                │                        │
  │                                │ POST .../encode        │
  │                                │ (Bearer <sess_token>)  │
  │                                │◄───────────────────────│
  │                                │                        │
  │                                │ Poll until completed   │
  │                                │◄───────────────────────│
  │                                │                        │
  │ Webhook: completed             │                        │
  │◄───────────────────────────────│                        │
  │                                │                        │
  │          ┌─────────────────────│                        │
  │          │ Webhook also sent   │                        │
  │          │ to SaaS Service     │                        │
  │          │ (bound to API key)  │                        │
  │          ▼                     │                        │
  │   ┌──────────────┐            │                        │
  │   │ SaaS Service │            │                        │
  │   │ (history,    │            │                        │
  │   │  billing)    │            │                        │
  │   └──────────────┘            │                        │
```

**Key points**:
- The third-party server talks **directly to the Encoding API** — the SaaS Service is not in the request path at all
- Session creation, upload, encoding, and polling all happen between the third-party and the Encoding API
- The SaaS Service learns about sessions via webhooks (bound to the API key's `webhookUrl`) for history and billing
- The third-party can optionally receive its own webhooks if configured per-session in `CreateSessionDto`

#### FR-3.3.5 Session Ownership

On the Encoding API: session tokens provide implicit access control — a token for session A cannot access session B. The Encoding API does not track users or ownership.

On the SaaS Service: sessions are mapped to users via the API key's `metadata.userId`. When the SaaS Service receives a webhook, it looks up which user owns the API key and records the session in that user's history.

### 3.4 Session History & Persistence

#### FR-3.4.1 Persistent Storage

Session records shall be persisted to a database. The system shall support:

- CouchDB as the primary database — its document-oriented model is a natural fit for the JSON-heavy session data (probe results, encode configs, cost estimates), and its built-in replication and horizontal scaling simplify future multi-node deployments
- Session state transitions persisted as they occur (not just final state)
- CouchDB Mango queries (with indexes) for session listing, filtering, and usage aggregation — no MapReduce views

**Note**: Transient encoding state (FFmpeg process handles, worker thread references, file paths) remains in-memory. CouchDB's schema-free documents eliminate the need for JSON columns or ORM mapping — entities are stored as-is.

**Data retention strategy**: While a session is active (non-terminal status), the full session document is stored including probe results, encode config, and cost estimate. Once a session reaches a terminal state (`completed` or `failed`), the document is compacted to a **summary-only** form (see FR-3.4.4) to minimize storage. Full probe results and encode configs are not retained in history.

#### FR-3.4.2 Session History Retention

Completed and failed sessions shall be retained in the database for a configurable period:

- **Default**: 30 days
- **Configurable**: Per-instance via environment variable (`SESSION_HISTORY_TTL_DAYS`)
- **Admin override**: Administrators shall be able to set per-user retention periods (for future premium tiers)

#### FR-3.4.3 Session Expiry

An automated process (cron job or scheduled task) shall:

- Run periodically (default: daily)
- Delete session documents older than the configured retention period
- Not delete S3 output — the user's S3 bucket is their responsibility

#### FR-3.4.4 Session History Data Model

When a session reaches a terminal state, the stored document shall be compacted to retain only:

- Session ID
- Status (`completed` or `failed`)
- Creation timestamp
- Completion/failure timestamp
- **Summary**: encoding type (`video` / `audio`), rendition count, audio group count, source duration, segment format, encoder used
- **S3 output references**: file list (S3 object keys), master playlist key, angle playlists (if applicable), thumbnails VTT key
- **Encryption key** (if HLS encryption was enabled) — retained so the user can decrypt and play back the HLS output from S3 at any time within the retention window
- **Cost estimate**: pixel-minutes, audio minutes, breakdown (for billing/usage history)
- Error message (if failed)

Full probe results, raw encode config, and session config (including S3 credentials) are **purged** from the document on completion. This reduces storage and eliminates credential retention.

#### FR-3.4.5 Session History API

The session listing endpoint (FR-3.1.5) shall include historical sessions within the retention window. Each session record shall include the summary data described in FR-3.4.4.

**Endpoint**: `GET /api/sessions` (paginated, filterable by status)

#### FR-3.4.6 Session Detail Retrieval

`GET /api/sessions/:id` shall return session details for any session within the retention window, regardless of status. For completed/failed sessions, this returns the compacted summary form (FR-3.4.4). For active sessions, this returns the full session document (including probe results, encode config, and progress).

#### FR-3.4.7 Historical Session Playback

For completed sessions within the retention window, the system shall support video playback from the user's S3 storage:

- The session history stores the master playlist S3 key and the S3 config reference (bucket, endpoint, region) from the user's SaaS profile (see FR-3.4.9)
- If the HLS output was encrypted, the stored encryption key allows the system to serve the decryption key via the existing preview endpoint pattern
- The web app's Video.js player (with the HLS quality selector and thumbnail preview plugins) can play back the content directly from the S3 URL
- Playback is only possible if the S3 storage remains accessible (the user has not deleted the output or revoked access)

#### FR-3.4.8 Session Import from S3

Users shall be able to import a session by pointing the system at existing HLS output in their S3 storage. This is an import feature for bringing external or expired content into the SaaS session history. Use cases:

- A session expired from history (past retention window) but the S3 output still exists
- Output was encoded by a standalone Encoding API instance (without SaaS involvement) and the user wants to manage it through the SaaS dashboard
- Output was encoded by a different system entirely and the user wants playback and management via the SaaS web app
- The SaaS Service's CouchDB was lost or reset and sessions need to be re-imported

**Import input** — the user provides one of:

1. **Master playlist reference**: The S3 key of a single `master.m3u8` file — the system parses it to discover all variant/audio playlists and their segments
2. **S3 folder path**: An S3 path prefix (folder) containing `.m3u8` playlist files — the system scans the folder, identifies the master playlist and per-angle/variant playlists, and reconstructs the session structure

In both cases, the user selects which saved S3 config (FR-3.4.9) to use for access.

**Import process**:

1. User submits recovery request via the web app or `POST /saas/sessions/recover`
2. SaaS Service connects to S3 using the user's saved S3 config
3. SaaS Service reads the master playlist (or scans the folder for `.m3u8` files to identify it)
4. SaaS Service parses the master playlist to extract:
   - Video renditions (resolution, bandwidth from `#EXT-X-STREAM-INF`)
   - Audio groups and tracks (from `#EXT-X-MEDIA` entries)
   - Angle playlists (if multi-angle)
   - Encryption key URI (if `#EXT-X-KEY` present)
   - Segment format (fMP4 if `#EXT-X-MAP` present, MPEG-TS otherwise)
5. SaaS Service lists S3 objects under the path to determine file count and discover thumbnails VTT (if present)
6. SaaS Service creates a completed session document in CouchDB with:
   - Status: `completed`
   - Summary reconstructed from playlist parsing (rendition count, audio group count, segment format)
   - S3 output references (file list, master playlist key, angle playlists, thumbnails VTT)
   - `s3ConfigId` referencing the selected S3 config
   - `imported: true` flag to distinguish from organically completed sessions
   - No cost estimate, no encryption key (unless the user provides the key separately)

**Encryption key handling**: If the imported HLS output uses AES-128 encryption (`#EXT-X-KEY` in playlists), the user can optionally provide the encryption key during import. If provided, it is stored in the session document to enable preview playback. If not provided, the session is imported without playback capability (the S3 URLs and file list are still available).

**Endpoint**: `POST /saas/sessions/import`
**Auth**: JWT
**Request body**:

```json
{
    "s3ConfigId": "<s3config-uuid>",
    "masterPlaylistKey": "output/master.m3u8",
    "s3FolderPrefix": null,
    "encryptionKey": null
}
```

One of `masterPlaylistKey` or `s3FolderPrefix` is required. If both are provided, `masterPlaylistKey` takes precedence.

#### FR-3.4.9 SaaS User S3 Configuration

To support session history playback and simplify the session creation flow, the system shall allow users to store S3 configuration in their user profile:

- Users can save one or more S3 configurations (endpoint, bucket, region, access key, secret key, path prefix) in their account settings
- S3 credentials stored in the user profile are encrypted at rest (see NFR-4.2.3)
- When creating a session, users can select a saved S3 config instead of entering credentials each time
- The saved S3 config reference (not the credentials themselves) is retained in completed session history, enabling playback from the correct bucket
- For third-party API integrations, S3 config can still be passed per-session in `CreateSessionDto` (the per-session config takes precedence)

### 3.5 Payment Gateway Support (Interfaces Only)

**Note**: This section defines interfaces and abstractions to be implemented in code. No payment processing shall be implemented in this phase. The billing model is **pay-as-you-go** based on output pixel-minutes, with a free tier limited to transmuxing (copy/passthrough) and audio-only encoding.

#### FR-3.5.1 Billing Model & Billing Unit

The intended billing model (for future implementation) is pay-as-you-go, using **output pixel-minutes** as the billing unit. This is the industry-standard approach (used by Mux, AWS MediaConvert, Bitmovin) because it is deterministic, hardware-independent, and can be computed before encoding starts.

**Billing unit**: 1080p30-equivalent minutes (normalized pixel-minutes)

**Formula per video rendition**:

```
rendition_cost = duration_minutes × (width × height × fps) / (1920 × 1080 × 30)
```

**Total session cost** = sum of all rendition costs (copy-mode renditions contribute 0)

**Example** — 10-minute source encoded to an ABR ladder:

| Rendition | Calculation | 1080p30-eq min |
|-----------|-------------|----------------|
| 1080p30 | 10 × 1920×1080×30 / (1920×1080×30) | 10.00 |
| 720p30 | 10 × 1280×720×30 / (1920×1080×30) | 4.44 |
| 480p30 | 10 × 854×480×30 / (1920×1080×30) | 1.98 |
| 360p30 | 10 × 640×360×30 / (1920×1080×30) | 1.11 |
| **Total** | | **17.53** |

**Billing rules**:

- **Copy-mode video renditions** (`-c:v copy`): 0 pixel-minutes (no encoding work performed)
- **Audio-only encoding**: Billed per source minute at a flat rate (no pixel calculation). Audio copy-mode (`-c:a copy`): 0 minutes
- **GPU vs CPU acceleration**: Same pixel-minute cost to the user regardless of encoder. GPU acceleration is an operational efficiency, not a billing variable
- **Failed encodes**: Not billed (0 cost)
- **Multi-angle video**: Each video track's renditions are summed independently

**Tier structure**:

- **Free tier**: Transmuxing (all video renditions copy-mode) and audio-only encoding. Subject to a configurable monthly cap on source minutes processed (e.g., 60 source minutes/month). Video re-encoding is not available.
- **Paid (pay-as-you-go)**: All encoding types billed per 1080p30-equivalent minute at the configured rate. Audio-only billed per source minute at a separate (lower) rate.
- **Per-customer discounts**: Administrators can configure a discount percentage per user (e.g., 15% discount for a high-volume customer). Discounts are applied to all billable pixel-minutes for that user.

#### FR-3.5.2 Cost Estimation

The system shall provide cost estimation **before encoding starts**, since all inputs required for the pixel-minutes calculation are available after probing:

- **Source duration** — from probe results (`probeResult.format.duration`)
- **Source frame rate** — from probe results (per video track, used as output fps when not re-encoding to a different fps)
- **Output rendition dimensions** — from the encode config (`width × height` per `VideoRendition`)
- **Output frame rate** — source fps (the system does not currently support fps conversion)
- **Copy-mode flag** — from the encode config (`copy: true` per rendition)

##### FR-3.5.2.1 Cost Estimation API

The system shall expose a cost estimation endpoint:

**Endpoint**: `POST /api/sessions/:id/estimate`
**Auth**: JWT, API Key, or Session Token
**Request body**: `EncodeConfig` (same shape as the encode start request)
**Response**:

```json
{
    "estimatedCost": {
        "pixelMinutes": 17.53,
        "audioMinutes": 10.0,
        "breakdown": [
            {
                "type": "video",
                "label": "1080p",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "durationMinutes": 10.0,
                "pixelMinutes": 10.0,
                "copy": false
            },
            {
                "type": "video",
                "label": "720p",
                "width": 1280,
                "height": 720,
                "fps": 30,
                "durationMinutes": 10.0,
                "pixelMinutes": 4.44,
                "copy": false
            },
            {
                "type": "audio",
                "label": "HD Audio",
                "durationMinutes": 10.0,
                "copy": false
            }
        ],
        "freeTierEligible": false,
        "discountPercent": 15,
        "estimatedPriceBeforeDiscount": null,
        "estimatedPriceAfterDiscount": null
    }
}
```

**Note**: `estimatedPriceBeforeDiscount` and `estimatedPriceAfterDiscount` are null until pricing is configured (future payment gateway phase). The `pixelMinutes` and `audioMinutes` values are always returned and are the basis for future pricing.

The estimation endpoint does not modify session state and can be called multiple times as the user adjusts their encode config.

##### FR-3.5.2.2 Cost Estimation in UI

The `EncodeConfigForm` component (from the `encode-config` package) shall compute and display an estimated cost summary as the user configures renditions. Since probe results and encode config are both available client-side, the pixel-minutes calculation can run entirely in the browser without an API call:

- Display total pixel-minutes (1080p30-equivalent) and audio minutes
- Update in real-time as renditions are added, removed, or toggled between encode/copy mode
- Show per-rendition breakdown (resolution, duration, pixel-minutes contribution)
- Indicate free tier eligibility (all video renditions are copy-mode or audio-only)
- When pricing is configured (future), display estimated price with applicable discount

##### FR-3.5.2.3 Cost Estimation Utility

The pixel-minutes calculation shall be implemented as a shared pure function in the `encode-config` package (alongside the existing types), so it can be used by both the client-side UI and the server-side API without duplication:

```typescript
interface CostEstimate {
    pixelMinutes: number;           // Total 1080p30-equivalent minutes
    audioMinutes: number;           // Total audio encoding minutes
    breakdown: CostBreakdownItem[]; // Per-rendition/group breakdown
    freeTierEligible: boolean;      // True if all video is copy-mode or audio-only
}

interface CostBreakdownItem {
    type: 'video' | 'audio';
    label: string;
    width?: number;                 // Video only
    height?: number;                // Video only
    fps?: number;                   // Video only
    durationMinutes: number;
    pixelMinutes?: number;          // Video only (0 for copy-mode)
    copy: boolean;
}

function estimateEncodingCost(
    probeResult: ProbeResult,
    encodeConfig: EncodeConfig,
): CostEstimate;
```

#### FR-3.5.3 Billing Account Model

The data model shall include a `BillingAccount` entity associated with each user, containing:

- Account ID
- User ID (FK)
- Plan tier (enum: `free`, `payg`, `custom`)
- Status (enum: `active`, `suspended`, `cancelled`)
- Discount percentage (0–100, default 0 — admin-configurable per customer)
- Free tier monthly source minutes cap (default from global config, admin-overridable per user)
- Payment provider reference (nullable — for future Stripe/Paddle customer ID)
- Billing cycle dates (current period start/end)

#### FR-3.5.4 Usage Metering Interface

The system shall define a `UsageMeterService` interface that records encoding events for future billing:

```typescript
interface UsageMeterService {
    recordSessionCreated(userId: string, sessionId: string): Promise<void>;
    recordEncodingStarted(userId: string, sessionId: string, estimate: CostEstimate): Promise<void>;
    recordEncodingCompleted(userId: string, sessionId: string, stats: EncodingStats): Promise<void>;
    recordStorageUsed(userId: string, sessionId: string, bytes: number): Promise<void>;
    getUsageSummary(userId: string, periodStart: Date, periodEnd: Date): Promise<UsageSummary>;
}

interface EncodingStats {
    durationSeconds: number;           // Source media duration
    wallClockSeconds: number;          // Actual encoding time (operational metric, not for billing)
    outputBytes: number;               // Total output size
    encoder: AccelMode;                // cpu, nvidia, or apple (operational metric, not for billing)
    encodeType: 'video' | 'audio';
    costEstimate: CostEstimate;        // Final pixel-minutes breakdown (computed from actual encode config)
}

interface UsageSummary {
    periodStart: Date;
    periodEnd: Date;
    totalSessions: number;
    totalPixelMinutes: number;         // Total 1080p30-equivalent minutes (billable video encoding)
    totalAudioMinutes: number;         // Total audio encoding minutes (billable)
    totalTransmuxMinutes: number;      // Copy-mode source minutes (free tier)
    totalSourceMinutesProcessed: number; // All source minutes (for free tier cap tracking)
    totalStorageBytes: number;
    discountPercent: number;
}
```

The initial implementation shall be a no-op logger that records events to the application log. A real payment provider integration will replace this in a future phase.

#### FR-3.5.5 Plan Limits Interface

The system shall define a `PlanLimitsService` interface for enforcing plan-based restrictions:

```typescript
interface PlanLimitsService {
    canCreateSession(userId: string): Promise<{ allowed: boolean; reason?: string }>;
    canStartEncode(userId: string, config: EncodeConfig, estimate: CostEstimate): Promise<{ allowed: boolean; reason?: string }>;
    getMaxUploadSize(userId: string): Promise<number>;
    getMaxConcurrentSessions(userId: string): Promise<number>;
    getSessionRetentionDays(userId: string): Promise<number>;
    getRemainingFreeSourceMinutes(userId: string): Promise<number>;
}
```

The initial implementation shall return permissive defaults (unlimited) for all checks.

When billing is implemented, `canStartEncode()` shall enforce:
- **Free tier**: Only allow if `estimate.freeTierEligible === true` (all video renditions are copy-mode, or audio-only). Reject video re-encoding with a message indicating upgrade is required. Enforce monthly source minutes cap via `getRemainingFreeSourceMinutes()`.
- **Paid tier**: Allow all encoding types. Usage is metered in pixel-minutes and billed.

#### FR-3.5.6 Billing Event Hooks

The encoding pipeline shall emit billing-relevant events at these points:

- Session creation
- Encoding started (with `CostEstimate` computed from probe results + encode config)
- Encoding completed (with `EncodingStats` including final pixel-minutes and operational metrics)
- Encoding failed (no charge — cost estimate is discarded)
- S3 upload completed (with total bytes uploaded)

These hooks shall call the `UsageMeterService` interface. The no-op implementation ensures zero overhead until billing is activated.

#### FR-3.5.7 Plan Tier Enforcement Points

Plan limit checks shall be integrated at:

- `POST /api/sessions` — Check `canCreateSession()` before creating
- `POST /api/sessions/:id/encode` — Compute `CostEstimate`, check `canStartEncode()` before queuing (enforce free tier restrictions: transmux/audio only, monthly source minutes cap)
- Tus upload — Apply `getMaxUploadSize()` as tus max size
- Session listing — Apply `getSessionRetentionDays()` for history window

The permissive initial implementation means these checks pass through without blocking any operation.

#### FR-3.5.8 Admin Discount Configuration

Administrators shall be able to configure per-customer discount percentages through the admin panel and admin API:

- Set discount percentage (0–100) on a user's billing account via `PATCH /api/admin/users/:userId`
- Override the free tier monthly source minutes cap per user
- View effective pricing for a user (base rate minus discount)
- Discount is applied to all billable pixel-minutes and audio minutes for the user

### 3.6 Admin Panel & User Management

#### FR-3.6.1 Admin Role

The system shall support an `admin` role. Admin status is determined by the `role` field on the User document.

**Initial admin bootstrap**: The first admin user shall be created via a **CLI seed command** (e.g., `npm -w api run seed:admin --email admin@example.com --name "Admin User"`). This command creates a User document with `role: admin` in CouchDB. The admin then logs in via Auth0, the system matches by email and links their `auth0Id` (per FR-3.1.1). No environment variable or first-login magic — explicit CLI action is required before the system is usable.

Admin users have access to all admin API endpoints and the admin panel SPA. Regular users cannot access admin functionality.

#### FR-3.6.2 User Provisioning (Manual)

Administrators shall be able to create user accounts manually through the admin panel and admin API. User creation requires:

- Email address (unique, used as login identifier)
- Display name
- Role assignment (`user` or `admin`)
- Optional: session history retention override (days)
- Optional: plan tier assignment

On creation, the system shall create a User document in CouchDB with the provided email. **Auth0 is not involved in provisioning** — the admin does not need to create an Auth0 account. The user signs up with Auth0 independently (or may already have an Auth0 account). On first login (or next page refresh), the system matches the Auth0 JWT's email claim to the existing User document, populates the `auth0Id` field, and maps the user's permissions (role, plan tier, status) to their session. Subsequent requests use `auth0Id` for fast lookup.

If no User document matches the authenticated email, the request is rejected with `403 Forbidden` (as per FR-3.1.1). This keeps Auth0 as a pure authentication provider — all authorization and permissions are managed entirely by the SaaS API.

#### FR-3.6.3 User Management

Administrators shall be able to:

- **List users** — Paginated list with search by email/name, filter by role/status
- **View user details** — Profile, session count, API key count, usage summary, plan tier
- **Edit user** — Update name, role, retention override, plan tier
- **Disable user** — Soft-disable a user account (sets `status` to `disabled`). Disabled users cannot authenticate or use API keys. Active sessions owned by a disabled user continue to completion but no new sessions can be created.
- **Re-enable user** — Restore a disabled user account
- **Delete user** — Hard-delete a user and all associated data (sessions, API keys, usage records). Requires confirmation. Does not delete S3 output.
- **View user sessions** — Browse a user's session history with the same filtering/sorting as the user-facing endpoint
- **Revoke user API keys** — Revoke any or all API keys belonging to a user

#### FR-3.6.4 Admin Panel SPA

The admin panel shall be a **separate Vue 3 SPA** (`admin/` workspace) with its own build and deployment. It connects to the same API as the user-facing web app but is intended for a different audience (system administrators) and serves a different function (user/system management vs media encoding workflow).

- **Workspace**: `admin/` (npm workspace alongside `app/`, `api/`, `encode-config/`, `tusd/`)
- **Stack**: Vue 3 (Composition API), Vite, Tailwind CSS, Auth0 (shared tenant, separate Auth0 app or shared with redirect URIs)
- **Hosting**: Deployable on a separate subdomain (e.g., `admin.luminary.io`) with optional network-level restrictions (IP allowlisting, VPN)
- **Auth**: Auth0 login → system checks `role === 'admin'` on the matched User document → rejects non-admin users

#### FR-3.6.5 Admin Dashboard

The admin panel shall provide a dashboard overview showing:

- Total user count (active / disabled)
- Active sessions (by status: encoding, queued, uploading)
- Encoding queue depth and current job
- Recent session completions/failures (last 24 hours)
- System health indicators (GPU availability, disk usage for work directory)

#### FR-3.6.6 Session History Administration

Administrators shall be able to:

- Browse all sessions across all users (with user filter)
- View full session details for any session
- Manually delete individual sessions
- Configure the global session retention period
- Trigger a manual session expiry cleanup run

#### FR-3.6.7 Admin API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/users` | JWT (admin) | List all users (paginated, searchable) |
| POST | `/api/admin/users` | JWT (admin) | Create user account |
| GET | `/api/admin/users/:userId` | JWT (admin) | Get user details + usage summary |
| PATCH | `/api/admin/users/:userId` | JWT (admin) | Update user (name, role, plan, retention) |
| POST | `/api/admin/users/:userId/disable` | JWT (admin) | Disable user account |
| POST | `/api/admin/users/:userId/enable` | JWT (admin) | Re-enable user account |
| DELETE | `/api/admin/users/:userId` | JWT (admin) | Delete user and all associated data |
| GET | `/api/admin/users/:userId/sessions` | JWT (admin) | List user's sessions |
| DELETE | `/api/admin/users/:userId/keys/:keyId` | JWT (admin) | Revoke a user's API key |
| GET | `/api/admin/sessions` | JWT (admin) | List all sessions across users |
| DELETE | `/api/admin/sessions/:sessionId` | JWT (admin) | Delete any session |
| GET | `/api/admin/dashboard` | JWT (admin) | Dashboard stats (users, queue, recent activity) |
| POST | `/api/admin/sessions/cleanup` | JWT (admin) | Trigger manual session expiry cleanup |

#### FR-3.6.8 Admin Guard

All `/api/admin/*` endpoints shall be protected by an `AdminGuard` that verifies the authenticated user has the `admin` role. Non-admin requests shall receive `403 Forbidden`.

### 3.7 Automated User Signup (Future — Interfaces Only)

**Note**: This section defines interfaces and data model provisions for self-service user registration. The implementation is deferred to a future phase. Until then, all users are created manually by administrators (FR-3.6.2).

#### FR-3.7.1 Signup Service Interface

The system shall define a `SignupService` interface to support future self-service registration:

```typescript
interface SignupService {
    initiateSignup(email: string, name: string): Promise<{ userId: string; verificationRequired: boolean }>;
    verifyEmail(token: string): Promise<{ userId: string; verified: boolean }>;
    completeOnboarding(userId: string, preferences: OnboardingPreferences): Promise<void>;
    isSignupEnabled(): boolean;
}
```

The initial implementation shall return `isSignupEnabled() = false` and throw on all other methods. The admin panel is the sole user creation path until signup is implemented.

#### FR-3.7.2 Data Model Provisions for Signup

The User entity (section 5.3) shall include fields to support future signup:

- `status`: enum (`active`, `disabled`, `pending_verification`) — `pending_verification` is reserved for self-service signup flow
- `emailVerifiedAt`: nullable timestamp — set when email is verified (for future signup) or on admin-created accounts (immediately verified)
- `invitedBy`: nullable UUID (FK → User) — tracks which admin created the user (null for self-signup)
- `onboardingCompletedAt`: nullable timestamp — for future onboarding flow

#### FR-3.7.3 Auth0 Integration Provisions

The system shall support two Auth0 integration modes (configurable via environment variable `AUTH0_SIGNUP_MODE`):

- `manual` (default): Auth0 accounts are created by the admin. The system links Auth0 `sub` to local User on first login. Unrecognized `sub` claims are rejected with `403 Forbidden`.
- `auto` (future): Auth0 Universal Login allows self-registration. On first login with an unrecognized `sub` claim, the system auto-creates a local User record via the `SignupService` interface.

### 3.8 System Configuration

#### FR-3.8.1 Environment Configuration

The following environment variables shall be added:

| Variable | Default | Description |
|----------|---------|-------------|
| `COUCHDB_URL` | (required) | CouchDB connection URL (e.g., `http://admin:password@localhost:5984`) |
| `COUCHDB_DATABASE` | `luminary` | CouchDB database name |
| `SESSION_HISTORY_TTL_DAYS` | `30` | Default session retention period |
| `API_KEY_RATE_LIMIT` | `100` | Requests per minute per API key |
| `SESSION_EXPIRY_CRON` | `0 3 * * *` | Cron schedule for session cleanup (daily at 03:00) |
| `AUTH0_SIGNUP_MODE` | `manual` | User provisioning mode: `manual` (admin-only) or `auto` (future self-service) |
| `FREE_TIER_MONTHLY_SOURCE_MINUTES` | `60` | Default monthly source minutes cap for free tier users (transmux + audio only) |

**Encoding API environment variables** (added):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTHORIZATION_WEBHOOK_URL` | (none) | Global authorization webhook URL (called before session creation and encode start). Per-API-key `authorizationUrl` takes precedence. |
| `AUTHORIZATION_WEBHOOK_TIMEOUT_MS` | `5000` | Timeout for authorization webhook calls |
| `AUTHORIZATION_WEBHOOK_FAIL_MODE` | `open` | Behavior when authorization webhook is unreachable: `open` (allow) or `closed` (deny) |

---

## 4. Non-Functional Requirements

### 4.1 Performance

#### NFR-4.1.1 Session Listing

Session listing queries shall complete within 200ms for users with up to 10,000 historical sessions.

#### NFR-4.1.2 API Key Validation

API key lookup and validation shall complete within 10ms (using an in-memory cache with database fallback).

#### NFR-4.1.3 Encoding Pipeline

The SaaS layer shall add no more than 50ms overhead to encoding pipeline operations (session state transitions, usage metering events).

### 4.2 Security

#### NFR-4.2.1 API Key Storage

API keys shall be stored as bcrypt or SHA-256 hashes. The plaintext key is never stored and is shown to the user only once at creation time.

#### NFR-4.2.2 Session Isolation

Session isolation shall be enforced at the data access layer, not just the controller layer. All database queries shall include a `userId` filter to prevent data leakage through any code path.

#### NFR-4.2.3 S3 Credential Handling

- **Encoding API**: S3 credentials are passed per-session in `CreateSessionDto` and held in-memory only for the duration of the session. No persistence.
- **SaaS Service**: Saved S3 configurations in CouchDB (FR-3.4.9) shall be encrypted at rest using application-level encryption (AES-256-GCM with a key from `S3_CREDENTIAL_ENCRYPTION_KEY` env var). The SaaS Service passes S3 credentials to the Encoding API when creating a session, then does not retain them.
- **Session token**: Stored encrypted in CouchDB during the session's active lifetime, purged on completion.

#### NFR-4.2.4 Audit Logging

The following actions shall be logged for security audit purposes:

- API key creation, revocation, and usage (first use, last use)
- Admin actions: user creation, role changes, account disable/enable/deletion
- Admin session operations: cross-user session viewing, manual session deletion, manual expiry cleanup triggers

Audit log entries shall include the acting user ID, timestamp, action type, and target resource ID.

### 4.3 Reliability

#### NFR-4.3.1 Crash Recovery

**Encoding API**: Stateless — sessions are ephemeral and lost on restart. Sessions in `encoding` or `uploading_to_s3` state are unrecoverable (FFmpeg process is lost). The Encoding API makes no attempt to recover sessions.

**SaaS Service**: On restart, the SaaS Service shall reconcile its CouchDB session documents with the Encoding API. Active sessions in CouchDB whose corresponding Encoding API sessions no longer exist shall be marked as `failed` with an appropriate error message.

**Session import**: Users can re-import lost sessions from S3 output via the session import feature (FR-3.4.8) if the HLS files still exist in their S3 storage.

#### NFR-4.3.2 API Key Cache Invalidation

When an API key is revoked, the in-memory cache shall be invalidated within 5 seconds across all server instances (relevant for future horizontal scaling).

### 4.4 Testing

#### NFR-4.4.1 Test Coverage

All UI and API code shall maintain **100% test coverage** (line and branch). This applies to:

- **Encoding API** (`api/`): All services, controllers, guards, DTOs, and utilities — Vitest
- **SaaS Service** (`saas/`): All services, controllers, guards, and utilities — Vitest
- **Web App** (`app/`): All components, composables, API clients, and utilities — Vitest
- **Admin Panel** (`admin/`): All components, views, API clients, and utilities — Vitest
- **Encode Config** (`encode-config/`): All components, types, and utilities (including `estimateEncodingCost`) — Vitest
- **Video Player** (`@luminary/video-player`): All plugins — Vitest
- **Tusd Wrapper** (`tusd/`): All classes and utilities — Vitest

**Test framework**: Vitest shall be used as the sole test framework across all workspaces. Existing Jest tests in `api/` and `tusd/` shall be migrated to Vitest.

Coverage shall be enforced in CI. Pull requests that reduce coverage below 100% shall not be merged.

#### NFR-4.4.2 Simulation Testing for External Processes

External process calls (FFmpeg, ffprobe, tusd binary) shall be tested using **simulation/mock strategies** rather than requiring the actual binaries to be present in the test environment:

- **FFmpeg**: Mock the `child_process.spawn` call. Provide simulated stderr output (progress lines, completion) and simulated file system output (HLS playlists, segments). Test that `FfmpegService` correctly parses progress, handles errors, builds argument lists, and produces expected output structures.
- **ffprobe**: Mock the `child_process.execFile` call. Provide simulated JSON probe output (multiple formats: multi-track video, audio-only, missing bitrate, unusual codecs). Test that `ProbeService` correctly parses all probe strategies (bit_rate, BPS, NUMBER_OF_BYTES, packet-based CSV).
- **tusd binary**: Mock the child process spawn and HTTP proxy layer. Simulate tus protocol lifecycle hooks (pre-create, post-finish, progress). Test that `TusdServer` correctly dispatches hooks and manages lifecycle.
- **S3 (MinIO client)**: Mock the MinIO client methods (`fPutObject`, `listObjects`, `getObject`). Test upload concurrency, content type mapping, error handling, and session import S3 scanning.
- **Authorization webhook**: Mock the HTTP fetch call. Test allow/deny/timeout/unreachable scenarios for both fail-open and fail-closed modes.
- **CouchDB**: Mock the `nano` client. Test all Mango query construction, document CRUD, and index usage.

Simulation tests shall cover:
- Happy path (normal operation)
- Error cases (process crash, timeout, invalid output, unreachable services)
- Edge cases (zero-byte files, missing metadata, concurrent operations)

### 4.5 Compatibility

#### NFR-4.5.1 API Backward Compatibility

Existing API contracts (request/response shapes, endpoint paths) shall remain unchanged. New fields shall be additive. The session listing endpoint (`GET /api/sessions`) is new and does not conflict with existing routes.

#### NFR-4.5.2 Open-Source Encoding API Standalone Operation

The open-source Encoding API is a fully independent service. It has no dependency on the SaaS Service and can be used standalone:

- Sessions use in-memory storage (current behavior)
- Authentication via JWT tokens signed by any OIDC provider (or configurable static token for development)
- Webhook delivery to any configured URL (or none)
- No user management, no API keys, no session history, no billing
- Any client that can obtain a JWT and follow the session flow can use the Encoding API directly

---

## 5. Data Model Changes

All entities below are stored in CouchDB by the **SaaS Service**. The Encoding API has its own in-memory session state (unchanged from current behavior) and does not persist to CouchDB. Each document includes a `docType` field for distinguishing entity types. CouchDB Mango indexes are used for all queries.

### 5.1 Session Document

The SaaS Service maintains session documents in CouchDB, populated entirely from webhook callbacks received from the Encoding API. The SaaS Service does not create sessions — it learns about them when the Encoding API sends webhooks (bound to the API key's `webhookUrl`).

**Active session** (non-terminal status — created/updated by webhook):

```json
{
    "_id": "session:<encoding-api-session-id>",
    "docType": "session",
    "userId": "<user-uuid>",
    "apiKeyId": "<apikey-uuid>",
    "status": "created | uploading | uploaded | queued | encoding | encrypting | uploading_to_s3",
    "progress": 0,
    "error": null,
    "createdAt": "2026-03-16T10:00:00Z",
    "updatedAt": "2026-03-16T10:00:00Z"
}
```

**Note**: The `userId` is resolved from the API key's `metadata.userId` (stored in the CouchDB API key document). The SaaS Service does not store probe results, encode configs, S3 credentials, or session tokens — those live only on the Encoding API.

**Completed session** (compacted — summary only, per FR-3.4.4):

```json
{
    "_id": "session:<encoding-api-session-id>",
    "docType": "session",
    "userId": "<user-uuid>",
    "apiKeyId": "<apikey-uuid>",
    "status": "completed",
    "summary": {
        "encodeType": "video",
        "renditionCount": 4,
        "audioGroupCount": 2,
        "sourceDurationSeconds": 600,
        "segmentFormat": "fmp4",
        "encoder": "nvidia"
    },
    "s3ConfigId": "<s3config-uuid>",
    "files": ["output/master.m3u8", "output/v0/stream.m3u8", "..."],
    "masterPlaylist": "output/master.m3u8",
    "anglePlaylists": null,
    "thumbnailsVtt": "output/thumbnails/thumbnails.vtt",
    "encryptionKey": "<base64-encoded-aes128-key>",
    "costEstimate": {
        "pixelMinutes": 17.53,
        "audioMinutes": 10.0,
        "freeTierEligible": false
    },
    "error": null,
    "createdAt": "2026-03-16T10:00:00Z",
    "updatedAt": "2026-03-16T10:15:00Z",
    "completedAt": "2026-03-16T10:15:00Z",
    "expiresAt": "2026-04-15T10:15:00Z"
}
```

**Note**: Completion data (files, summary, cost estimate, encryption key) is populated from the Encoding API's webhook payload. The `s3ConfigId` references the user's saved S3 config (FR-3.4.9) for future playback. The `encryptionKey` is retained for decryption during playback.

### 5.2 API Key Document

```json
{
    "_id": "apikey:<uuid>",
    "docType": "apikey",
    "userId": "<user-uuid>",
    "name": "Production key",
    "keyPrefix": "lmc_live",
    "keyHash": "<sha256-hash>",
    "scopes": ["*"],
    "expiresAt": null,
    "lastUsedAt": null,
    "createdAt": "2026-03-16T10:00:00Z",
    "revokedAt": null
}
```

### 5.3 User Document

```json
{
    "_id": "user:<uuid>",
    "docType": "user",
    "auth0Id": null,
    "email": "user@example.com",
    "name": "Jane Smith",
    "role": "user | admin",
    "status": "active | disabled | pending_verification",
    "sessionRetentionDaysOverride": null,
    "emailVerifiedAt": null,
    "invitedBy": null,
    "onboardingCompletedAt": null,
    "createdAt": "2026-03-16T10:00:00Z",
    "updatedAt": "2026-03-16T10:00:00Z"
}
```

### 5.4 S3 Config Document

```json
{
    "_id": "s3config:<uuid>",
    "docType": "s3config",
    "userId": "<user-uuid>",
    "name": "Production CDN",
    "endPoint": "s3.example.com",
    "port": null,
    "useSSL": true,
    "bucket": "media-output",
    "region": "us-east-1",
    "accessKey": "<encrypted>",
    "secretKey": "<encrypted>",
    "pathPrefix": "encoded/",
    "createdAt": "2026-03-16T10:00:00Z",
    "updatedAt": "2026-03-16T10:00:00Z"
}
```

**Note**: `accessKey` and `secretKey` are encrypted at rest (see NFR-4.2.3). Referenced by `s3ConfigId` in session documents for playback from history.

### 5.5 Billing Account Document (Stub)

```json
{
    "_id": "billing:<uuid>",
    "docType": "billing",
    "userId": "<user-uuid>",
    "planTier": "free | payg | custom",
    "status": "active | suspended | cancelled",
    "discountPercent": 0,
    "freeSourceMinutesMonthlyCapOverride": null,
    "providerCustomerId": null,
    "currentPeriodStart": "2026-03-01T00:00:00Z",
    "currentPeriodEnd": "2026-03-31T23:59:59Z",
    "createdAt": "2026-03-16T10:00:00Z",
    "updatedAt": "2026-03-16T10:00:00Z"
}
```

### 5.6 Usage Record Document (Stub)

```json
{
    "_id": "usage:<uuid>",
    "docType": "usage",
    "userId": "<user-uuid>",
    "sessionId": "<session-uuid>",
    "eventType": "session_created | encoding_started | encoding_completed | storage_used",
    "metadata": { /* EncodingStats / CostEstimate */ },
    "billable": false,
    "pixelMinutes": null,
    "audioMinutes": null,
    "sourceDurationMinutes": null,
    "createdAt": "2026-03-16T10:00:00Z"
}
```

### 5.7 CouchDB Mango Indexes

The following Mango indexes shall be created for efficient querying. No MapReduce views are used.

| Index Name | Fields | Purpose |
|------------|--------|---------|
| `sessions-by-user` | `docType`, `userId`, `createdAt` | List sessions for a user (paginated, sorted) |
| `sessions-by-user-status` | `docType`, `userId`, `status` | Filter sessions by status |
| `sessions-by-expiry` | `docType`, `expiresAt` | Expired session cleanup |
| `users-by-email` | `docType`, `email` | User lookup by email |
| `users-by-auth0id` | `docType`, `auth0Id` | User lookup on JWT auth |
| `apikeys-by-user` | `docType`, `userId`, `createdAt` | List keys for a user |
| `usage-by-user-period` | `docType`, `userId`, `createdAt` | Usage aggregation for billing period |
| `billing-by-user` | `docType`, `userId` | Billing account lookup |
| `s3configs-by-user` | `docType`, `userId`, `createdAt` | List saved S3 configs for a user |

---

## 6. API Surfaces

The system exposes two independent API surfaces. Clients (web app, admin panel, third-party servers) talk to the **SaaS Service**. The SaaS Service talks to the **Encoding API** internally. Clients may also talk directly to the Encoding API using session tokens for upload, polling, and preview.

### 6.1 Encoding API Endpoints (Open Source)

The Encoding API extends its current endpoint structure with API key authentication and key management.

**Session operations** (JWT, API Key, or Session Token):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/sessions` | JWT or API Key | Create encoding session (returns `sessionToken`) |
| ALL | `/api/tus`, `/api/tus/*` | Session Token | Resumable file upload |
| POST | `/api/sessions/:id/encode` | JWT, API Key, or Session Token | Submit encoding config |
| GET | `/api/sessions/:id` | JWT, API Key, or Session Token | Poll session status |
| GET | `/api/sessions/:id/preview/key` | Session Token | HLS encryption key |
| GET | `/api/sessions/:id/preview/*` | Session Token | Rewritten HLS playlists |
| DELETE | `/api/sessions/:id` | JWT or API Key | Cancel and delete session |

**API key management** (JWT only — privileged):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/keys` | JWT | Create API key (with `webhookUrl`, `metadata`, optional expiry) |
| GET | `/api/keys` | JWT | List API keys (prefix, name, dates — never full key) |
| DELETE | `/api/keys/:keyId` | JWT | Revoke API key |

**Authentication**: The Encoding API supports three auth methods: (1) **JWT** (generic OIDC, any provider) for all operations including key management — used by the SaaS web app and the SaaS Service, (2) **API key** (`X-API-Key` header) for session creation/deletion and per-session operations — used by third-party services, (3) **Session token** (`Authorization: Bearer`) for per-session operations — used by end users in third-party web apps. The Encoding API has no concept of users, history, or billing.

**Encoding API OIDC configuration**: The current Auth0-specific env vars (`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`) shall be replaced with generic OIDC configuration:

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER_URL` | OIDC issuer URL (e.g., `https://myapp.auth0.com/`). JWKS URI is discovered via `{issuer}/.well-known/openid-configuration` |
| `OIDC_AUDIENCE` | Expected JWT audience claim |

This allows the Encoding API to work with any OIDC-compliant provider (Auth0, Keycloak, Okta, Azure AD, Google, etc.) without code changes.

### 6.2 SaaS Service Endpoints (Closed Source — New)

All SaaS Service endpoints are prefixed with `/saas/`. Clients authenticate with Auth0 JWT.

**Session history** (user-facing — sessions are created directly on the Encoding API, not here):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/saas/sessions` | JWT | List user's sessions (paginated, filterable, from CouchDB history) |
| GET | `/saas/sessions/:id` | JWT | Get session details (from CouchDB — active status via webhooks, historical from compacted docs) |
| POST | `/saas/sessions/estimate` | JWT | Compute cost estimate for encode config (uses `estimateEncodingCost()`) |
| POST | `/saas/sessions/import` | JWT | Import session from existing HLS output in S3 (FR-3.4.8) |

**API key management** (JWT-only — proxies to Encoding API):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/keys` | JWT only | Create API key (calls Encoding API `POST /api/keys` with user's webhook binding) |
| GET | `/saas/keys` | JWT only | List user's API keys (from CouchDB) |
| DELETE | `/saas/keys/:keyId` | JWT only | Revoke API key (calls Encoding API `DELETE /api/keys/:keyId` + removes from CouchDB) |

**S3 config management**:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/s3-configs` | JWT or API Key | Save S3 configuration to user profile |
| GET | `/saas/s3-configs` | JWT or API Key | List user's saved S3 configurations |
| PATCH | `/saas/s3-configs/:configId` | JWT or API Key | Update saved S3 configuration |
| DELETE | `/saas/s3-configs/:configId` | JWT or API Key | Delete saved S3 configuration |

**Admin endpoints** (JWT + admin role):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/saas/admin/users` | JWT (admin) | List all users |
| POST | `/saas/admin/users` | JWT (admin) | Create user account |
| GET | `/saas/admin/users/:userId` | JWT (admin) | Get user details + usage summary |
| PATCH | `/saas/admin/users/:userId` | JWT (admin) | Update user (name, role, plan, retention, discount) |
| POST | `/saas/admin/users/:userId/disable` | JWT (admin) | Disable user account |
| POST | `/saas/admin/users/:userId/enable` | JWT (admin) | Re-enable user account |
| DELETE | `/saas/admin/users/:userId` | JWT (admin) | Delete user and associated data |
| GET | `/saas/admin/users/:userId/sessions` | JWT (admin) | List user's sessions |
| DELETE | `/saas/admin/users/:userId/keys/:keyId` | JWT (admin) | Revoke user's API key |
| GET | `/saas/admin/sessions` | JWT (admin) | List all sessions across users |
| DELETE | `/saas/admin/sessions/:sessionId` | JWT (admin) | Delete any session |
| GET | `/saas/admin/dashboard` | JWT (admin) | Dashboard stats |
| POST | `/saas/admin/sessions/cleanup` | JWT (admin) | Trigger manual session expiry |

**Webhook receiver** (internal):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/webhooks/encoding` | Webhook token | Receives status/completion webhooks from Encoding API |
| POST | `/saas/webhooks/authorize` | (internal) | Authorization webhook — Encoding API calls this before session creation and encode start to check user/plan limits |

### 6.3 Key Response Shapes

**Encoding API** — `POST /api/sessions` (authenticated with API key):

```json
{
    "sessionId": "...",
    "sessionToken": "sess_...",
    "tusEndpoint": "/api/tus",
    "maxUploadSize": 10737418240
}
```

Third-party services receive this directly from the Encoding API. They can pass `sessionToken` to their end users for upload/poll/encode/preview.

**SaaS Service** — `GET /saas/sessions/:id` (active session, status updated via webhooks):

```json
{
    "sessionId": "...",
    "status": "encoding",
    "progress": 45,
    "createdAt": "2026-03-16T10:00:00Z"
}
```

**SaaS Service** — `GET /saas/sessions/:id` (historical — completed):

```json
{
    "sessionId": "...",
    "status": "completed",
    "createdAt": "2026-03-16T10:00:00Z",
    "completedAt": "2026-03-16T10:15:00Z",
    "expiresAt": "2026-04-15T10:15:00Z",
    "summary": {
        "encodeType": "video",
        "renditionCount": 4,
        "audioGroupCount": 2,
        "sourceDurationSeconds": 600,
        "segmentFormat": "fmp4",
        "encoder": "nvidia"
    },
    "masterPlaylist": "output/master.m3u8",
    "files": ["output/master.m3u8", "..."],
    "costEstimate": { "pixelMinutes": 17.53, "audioMinutes": 10.0 }
}
```

**SaaS Service** — `GET /saas/sessions` (list):

```json
{
    "sessions": [
        {
            "sessionId": "...",
            "status": "completed",
            "createdAt": "...",
            "completedAt": "...",
            "expiresAt": "...",
            "summary": { "..." }
        }
    ],
    "pagination": {
        "total": 142,
        "limit": 20,
        "offset": 0,
        "hasMore": true
    }
}
```

---

## 7. Migration Path

### 7.1 Phase 1 — SaaS Service & Encoding API Separation

1. Scaffold `saas/` workspace as a new NestJS service
2. Add CouchDB dependency (e.g., `nano` client) to SaaS Service
3. Create CouchDB Mango indexes (users, sessions, API keys, usage, billing, S3 configs)
4. Implement CLI seed command for initial admin user creation (`npm -w saas run seed:admin`)
5. Implement Auth0 JWT identity resolution in SaaS Service (email-based user matching, `auth0Id` linking)
6. Implement SaaS Service → Encoding API communication (session creation, webhook receiver)
7. Rename `uploadToken` to `sessionToken` in Encoding API (extend scope to full session lifecycle)
8. Refactor Encoding API JWT auth from Auth0-specific env vars (`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`) to generic OIDC (`OIDC_ISSUER_URL`, `OIDC_AUDIENCE`) with JWKS discovery

### 7.2 Phase 2 — Admin Panel & User Management

1. Implement `AdminGuard` for role-based access control in SaaS Service
2. Implement admin user CRUD API endpoints (create, list, view, edit, disable, enable, delete)
3. Implement admin session browsing endpoints (cross-user listing, manual cleanup)
4. Implement admin dashboard stats endpoint
5. Scaffold `admin/` workspace as a separate Vue 3 SPA (Vite, Tailwind, Auth0)
6. Build admin panel views (user list, user detail, session browser, dashboard)
7. Add admin-initiated API key revocation for any user

### 7.3 Phase 3 — Session History & API Keys

1. Implement webhook receiver in SaaS Service (receives status/completion from Encoding API, stores summaries in CouchDB)
2. Implement session listing endpoint with pagination and filtering (user-facing)
3. Implement session document compaction on terminal status (retain summary + S3 output references + encryption key)
4. Implement session expiry cron job
5. Implement S3 config CRUD endpoints and saved S3 config selection on session creation
6. Implement API key CRUD endpoints (user-facing, JWT-only)
7. Implement API key authentication guard in SaaS Service
8. Add rate limiting middleware for API key requests
9. Encrypt S3 credentials at rest (saved configs)

### 7.4 Phase 4 — Billing Interfaces & Open-Source Packaging

1. Implement billing document stubs and usage metering interface (no-op)
2. Implement plan limits interface (permissive defaults)
3. Wire billing event hooks into SaaS Service webhook receiver
4. Implement signup service interface (no-op, `isSignupEnabled() = false`)
5. Extract Video.js plugins to separate package
6. Clean up Encoding API: ensure zero SaaS dependencies, document standalone usage
7. Publish open-source packages

### 7.5 Phase 5 — Web App & Admin Dashboard (Closed Source)

1. Update web app to talk to SaaS Service (session creation, history) and Encoding API (upload, poll, encode via session token)
2. Add session history view (list, filter, sort, playback from S3)
3. Add API key management UI (create, list, revoke)
4. Add S3 config management UI (save, edit, delete saved configs)
5. Add account/settings page
6. Add usage dashboard (reads from usage records)

---

## 8. Resolved Decisions

All open questions have been resolved. Key decisions for reference:

| Decision | Resolution |
|----------|-----------|
| Database | CouchDB (document-oriented, built-in replication for scalability) |
| API key management auth | JWT-only (logged-in users create API keys; API keys cannot manage other API keys) |
| Session history data | Summaries only + S3 output references + encryption key (full probe results and encode configs purged on completion) |
| Queue fairness model | Strict FIFO (current behavior retained) |
| Team/org accounts | Individual users only (no team/org model) |
| S3 credentials | Per-user saved configs (profile) + per-session override for third-party API integrations |
| Open-source licensing | Apache 2.0 for encoding API + config; MIT for video player plugins + tusd wrapper |
| Admin panel architecture | Separate SPA (`admin/` workspace), independently built and deployed |
| Admin user creation & Auth0 | Auth0 is decoupled — admin enters email in SaaS API, system matches on login by email |
| Initial admin bootstrap | CLI seed command (`npm -w saas run seed:admin --email ...`) |
| Service architecture | Two independent services — Encoding API (open-source, stateless, GPU hardware) and SaaS Service (closed-source, CouchDB, management layer). All clients (web app, third-party) talk directly to Encoding API for encoding operations. SaaS Service handles users, API keys, billing, and history via webhooks |
| Web app interaction | Web app talks to Encoding API directly (JWT auth for sessions) and to SaaS Service for user management, API key management, session history, and billing |
| Authorization enforcement | Authorization webhook on Encoding API (FR-3.2.4) — calls SaaS Service before session creation and encode start to check user status, plan limits, and free tier restrictions. Fail-open by default, configurable to fail-closed. |
