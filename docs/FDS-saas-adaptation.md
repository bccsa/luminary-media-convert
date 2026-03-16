# Functional Design Specification: SaaS Adaptation

**Document ID**: FDS-SAAS-001
**Version**: 1.0
**Date**: 2026-03-16
**Status**: Draft
**Source**: URS-SAAS-001 v1.0

---

## 1. Introduction

### 1.1 Purpose

This document translates the User Requirements Specification (URS-SAAS-001) into a detailed functional design for adapting Luminary Media Convert into a multi-tenant SaaS platform. It describes the system architecture, component interactions, data flows, API contracts, data models, and implementation details required for development.

### 1.2 Traceability

Each design section references its originating URS requirements using FR/NFR identifiers.

### 1.3 Document Conventions

- **Encoding API** — the open-source, stateless encoding service (`api/`)
- **SaaS Service** — the closed-source management layer (`saas/`)
- **Web App** — the closed-source Vue 3 SPA for end users (`app/`)
- **Admin Panel** — the closed-source Vue 3 SPA for administrators (`admin/`)

---

## 2. System Architecture

*Traces: FR-3.1 through FR-3.8, NFR-4.4.2*

### 2.1 Deployment Topology

```
┌──────────────────┐     ┌──────────────────┐
│   Web App (SPA)  │     │ Admin Panel (SPA) │
│   app/           │     │ admin/            │
└────────┬─────────┘     └────────┬──────────┘
         │                        │
         │  JWT (Auth0)           │  JWT (Auth0, admin role)
         │                        │
         │              ┌─────────┴───────────┐
         │              │   SaaS Service      │
         │              │   saas/             │
         │              │   ┌───────────────┐ │
         │              │   │   CouchDB     │ │
         │              │   └───────────────┘ │
         │              └─────────┬───────────┘
         │                        │  JWT (service account)
         │                        │  for key management;
         │                        │  receives webhooks
         ▼                        ▼
         ┌─────────────────────────┐
         │   Encoding API          │
         │   api/                  │
         │   (GPU hardware)        │
         │   In-memory sessions    │
         └─────────────────────────┘
                    ▲
                    │  API key (X-API-Key header)
         ┌──────────┴──────────┐
         │  Third-Party        │
         │  Services           │
         └─────────────────────┘
```

### 2.2 Service Responsibilities

| Service | Responsibilities | State | Auth |
|---------|-----------------|-------|------|
| **Encoding API** | FFmpeg encoding, tus uploads, S3 upload, probing, HLS encryption, thumbnails, API key validation, authorization webhooks, session lifecycle webhooks | In-memory (ephemeral) | JWT, API Key, Session Token |
| **SaaS Service** | User management, API key lifecycle (proxy to Encoding API), session history, billing/usage metering, admin API, S3 config management, authorization webhook handler, session import | CouchDB (persistent) | JWT (Auth0) |

### 2.3 Communication Patterns

#### 2.3.1 Web App → Encoding API (Direct)

The web app authenticates with Auth0 JWT and creates sessions directly on the Encoding API. The web app includes the SaaS Service's webhook URL in the session's `webhook` config so the SaaS Service receives status updates.

```
Web App                          Encoding API
  │                                    │
  │  POST /api/sessions (JWT)          │
  │  { webhook: { url: saas/wh/enc }, │
  │    s3: {...} }                     │
  │ ──────────────────────────────────►│
  │                                    │──► Authorization webhook → SaaS Service
  │  { sessionId, sessionToken,        │
  │    tusEndpoint }                   │
  │ ◄──────────────────────────────────│
  │                                    │
  │  Upload via tus (sessionToken)     │
  │ ──────────────────────────────────►│
  │                                    │──► Status webhook → SaaS Service
  │  POST .../encode (sessionToken)    │
  │ ──────────────────────────────────►│
  │                                    │──► Authorization webhook → SaaS Service
  │  Poll GET .../status               │
  │ ──────────────────────────────────►│
  │                                    │──► Completion webhook → SaaS Service
```

#### 2.3.2 Third-Party → Encoding API (Direct)

Third-party services authenticate with an API key. Webhooks are bound to the API key's `webhookUrl` and `authorizationUrl` (configured by the SaaS Service at key creation time).

```
Third-Party Server               Encoding API
  │                                    │
  │  POST /api/sessions (API Key)      │
  │  { s3: {...} }                     │
  │ ──────────────────────────────────►│
  │                                    │──► Authorization webhook → SaaS Service
  │  { sessionId, sessionToken }       │
  │ ◄──────────────────────────────────│
  │                                    │
  │  Pass sessionToken to end users    │
  │                                    │
  │  End user: upload, poll, encode    │
  │  (sessionToken)                    │
  │                          ──────────►│
  │                                    │──► Status/completion webhooks → SaaS Service
```

#### 2.3.3 SaaS Service → Encoding API

The SaaS Service only calls the Encoding API for API key management (JWT auth):

| Operation | Call |
|-----------|------|
| Create API key | `POST /api/keys` (JWT) |
| Revoke API key | `DELETE /api/keys/:id` (JWT) |
| List API keys | `GET /api/keys` (JWT) |

#### 2.3.4 Encoding API → SaaS Service (Webhooks)

The Encoding API calls back to the SaaS Service on two webhook channels:

| Channel | URL | Trigger | Purpose |
|---------|-----|---------|---------|
| Authorization | `POST /saas/webhooks/authorize` | Before session creation and encode start | User/plan limit enforcement |
| Session lifecycle | `POST /saas/webhooks/encoding` | On every session status change | Session history, usage metering, billing |

---

## 3. Authentication & Authorization Design

*Traces: FR-3.1.1, FR-3.2.1–FR-3.2.6, FR-3.3.1–FR-3.3.5*

### 3.1 Encoding API Authentication (Open Source)

The Encoding API supports three credential types. All are validated locally — no external calls needed (except the optional authorization webhook).

#### 3.1.1 JWT Authentication (Generic OIDC)

- **Library**: `passport-jwt` with RS256 JWKS validation (existing)
- **Source**: `Authorization: Bearer <jwt>` header
- **Validation**: Signature, expiry, audience, issuer — generic OIDC (any provider)
- **Capabilities**: All operations including API key management
- **Identity**: JWT `sub` and `email` claims passed to authorization webhook (if configured)
- **Configuration**: `OIDC_ISSUER_URL` and `OIDC_AUDIENCE` env vars (replaces Auth0-specific `AUTH0_DOMAIN` / `AUTH0_AUDIENCE`)
- **JWKS discovery**: JWKS URI derived from `{OIDC_ISSUER_URL}/.well-known/openid-configuration` (standard OIDC discovery)

```typescript
// Refactored JwtStrategy — generic OIDC, not Auth0-specific
constructor() {
    const issuerUrl = process.env.OIDC_ISSUER_URL;  // e.g., "https://myapp.auth0.com/"
    const audience = process.env.OIDC_AUDIENCE;

    super({
        secretOrKeyProvider: passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 5,
            jwksUri: `${issuerUrl.replace(/\/$/, '')}/.well-known/jwks.json`,
        }),
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        audience,
        issuer: issuerUrl,
        algorithms: ['RS256'],
    });
}
```

#### 3.1.2 API Key Authentication

- **Header**: `X-API-Key: <key>`
- **Store**: In-memory `Map<keyHash, ApiKeyRecord>` with pluggable backend
- **Validation**: SHA-256 hash lookup, expiry check, revocation check
- **Capabilities**: Session operations (create, delete, encode, poll). Cannot manage other API keys.
- **Bound metadata**: Each key carries `webhookUrl`, `authorizationUrl`, and `metadata` (opaque JSON)

```typescript
interface ApiKeyRecord {
    id: string;
    keyHash: string;              // SHA-256 of the full key
    keyPrefix: string;            // First 8 chars for display
    name: string;
    webhookUrl?: string;
    authorizationUrl?: string;
    metadata?: Record<string, unknown>;
    scopes: string[];             // Future: fine-grained permissions
    expiresAt?: Date;
    lastUsedAt?: Date;
    createdAt: Date;
    revokedAt?: Date;
}
```

#### 3.1.3 Session Token Authentication

- **Header**: `Authorization: Bearer <sess_token>`
- **Format**: `sess_<32-char-random>` (distinguishable from JWT by prefix)
- **Store**: In-memory, per-session (part of the `Session` object)
- **Validation**: Direct lookup in `SessionService.tokenIndex` map
- **Capabilities**: Per-session operations only (upload, poll, encode, preview)
- **Scope**: Token for session A cannot access session B

#### 3.1.4 Auth Resolution Order

```typescript
// Guard chain on each request:
1. Check for X-API-Key header → ApiKeyGuard
2. Check for Authorization: Bearer header
   a. If starts with "sess_" → SessionTokenGuard
   b. Otherwise → JwtGuard (Auth0 JWT)
3. If no credentials → 401 Unauthorized
```

### 3.2 Authorization Webhook (Open Source)

*Traces: FR-3.2.4*

The Encoding API calls an external authorization webhook before privileged operations. This is the mechanism by which the SaaS Service enforces user/plan limits without the Encoding API needing any SaaS awareness.

#### 3.2.1 Webhook Resolution

```typescript
function resolveAuthorizationUrl(apiKey?: ApiKeyRecord): string | null {
    // 1. Per-key URL takes precedence
    if (apiKey?.authorizationUrl) return apiKey.authorizationUrl;
    // 2. Fall back to global env var
    if (process.env.AUTHORIZATION_WEBHOOK_URL) return process.env.AUTHORIZATION_WEBHOOK_URL;
    // 3. No URL configured → skip authorization (standalone mode)
    return null;
}
```

#### 3.2.2 Webhook Call Flow

```typescript
async function checkAuthorization(action: string, context: AuthContext): Promise<void> {
    const url = resolveAuthorizationUrl(context.apiKey);
    if (!url) return; // No authorization configured — allow

    const payload = {
        action,                    // "create_session" | "start_encode"
        apiKeyId: context.apiKey?.id ?? null,
        apiKeyMetadata: context.apiKey?.metadata ?? null,
        jwtSub: context.jwt?.sub ?? null,
        jwtEmail: context.jwt?.email ?? null,
        sessionId: context.sessionId ?? null,
        encodeConfig: context.encodeConfig ?? null,
        costEstimate: context.costEstimate ?? null,
        timestamp: new Date().toISOString(),
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(
                parseInt(process.env.AUTHORIZATION_WEBHOOK_TIMEOUT_MS ?? '5000'),
            ),
        });

        if (!response.ok && response.status >= 500) {
            throw new Error(`Authorization webhook returned ${response.status}`);
        }

        const body = await response.json();
        if (body.allowed === false) {
            throw new ForbiddenException(body.reason ?? 'Authorization denied');
        }
    } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        // Webhook unreachable or server error
        const failMode = process.env.AUTHORIZATION_WEBHOOK_FAIL_MODE ?? 'open';
        if (failMode === 'closed') {
            throw new ForbiddenException('Authorization service unavailable');
        }
        logger.warn('Authorization webhook failed, allowing request (fail-open)', error);
    }
}
```

#### 3.2.3 SaaS Service Authorization Handler

```
POST /saas/webhooks/authorize

1. Extract userId from payload:
   - If apiKeyMetadata.userId → lookup user by ID
   - If jwtEmail → lookup user by email
   - If neither → allow (unknown caller, fail-open)

2. Check user status:
   - If user.status === 'disabled' → { allowed: false, reason: "Account disabled" }

3. Check action-specific limits:
   - "create_session" → PlanLimitsService.canCreateSession(userId)
   - "start_encode" → PlanLimitsService.canStartEncode(userId, encodeConfig, costEstimate)

4. Return { allowed: true } or { allowed: false, reason: "..." }
```

### 3.3 SaaS Service Authentication

*Traces: FR-3.1.1*

The SaaS Service uses **Auth0** as its OIDC provider (unlike the Encoding API which is provider-agnostic). It validates Auth0 JWTs on all endpoints. It does not accept API keys or session tokens — those are Encoding API concepts.

#### 3.3.1 Identity Resolution Flow

```
Request with Authorization: Bearer <jwt>
  │
  ├─ Validate JWT (Auth0 JWKS, RS256, audience, issuer)
  │
  ├─ Extract sub + email from JWT claims
  │
  ├─ Lookup user by auth0Id (Mango query: docType=user, auth0Id=<sub>)
  │  ├─ Found → attach user to request context
  │  └─ Not found →
  │     ├─ Lookup user by email (Mango query: docType=user, email=<email>)
  │     │  ├─ Found → set user.auth0Id = sub, save, attach to request context
  │     │  └─ Not found →
  │     │     ├─ AUTH0_SIGNUP_MODE=manual → 403 "Account not provisioned"
  │     │     └─ AUTH0_SIGNUP_MODE=auto → SignupService.initiateSignup()
  │
  ├─ Check user.status
  │  ├─ "active" → proceed
  │  ├─ "disabled" → 403 "Account disabled"
  │  └─ "pending_verification" → 403 "Email verification pending"
  │
  └─ Attach user (id, role, email, planTier) to request context
```

---

## 4. Encoding API Design (Open Source Changes)

*Traces: FR-3.2.1, FR-3.2.2, FR-3.2.4, FR-3.2.6, FR-3.3.2, FR-3.3.3*

### 4.1 API Key Module

New NestJS module added to the Encoding API: `ApiKeyModule`.

#### 4.1.1 Module Structure

```
api/src/apikey/
├── apikey.module.ts              # Module definition
├── apikey.controller.ts          # REST endpoints (POST/GET/DELETE /api/keys)
├── apikey.service.ts             # Key store, hash validation, CRUD
├── apikey.guard.ts               # NestJS guard for X-API-Key header
├── dto/
│   ├── create-key.dto.ts         # { name, webhookUrl?, authorizationUrl?, metadata?, expiresAt? }
│   └── key-response.dto.ts       # { id, name, keyPrefix, createdAt, lastUsedAt, expiresAt }
└── interfaces/
    └── api-key-store.interface.ts # Pluggable store interface
```

#### 4.1.2 Key Store Interface

```typescript
interface ApiKeyStore {
    create(key: ApiKeyRecord): Promise<void>;
    findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
    findAll(): Promise<ApiKeyRecord[]>;
    updateLastUsed(id: string, timestamp: Date): Promise<void>;
    revoke(id: string): Promise<void>;
}
```

Default implementation: `InMemoryApiKeyStore` (Map-based). The SaaS Service can provide a persistent implementation if needed, but since the SaaS Service generates keys via the Encoding API's REST endpoints, the in-memory store is sufficient (keys are recreated on restart by the SaaS Service reconciliation process).

#### 4.1.3 Key Generation

```typescript
function generateApiKey(): { key: string; hash: string; prefix: string } {
    const random = crypto.randomBytes(32).toString('hex');
    const key = `lmc_${random}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const prefix = key.substring(0, 12); // "lmc_XXXXXXXX"
    return { key, hash, prefix };
}
```

#### 4.1.4 Rate Limiting

Per-key rate limiting using a sliding window counter (in-memory):

```typescript
interface RateLimitEntry {
    keyId: string;
    windowStart: number;
    count: number;
}
```

Default: 100 requests/minute/key. Configurable via `API_KEY_RATE_LIMIT` env var. Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### 4.2 Session Token Changes

*Traces: FR-3.3.2*

Rename `uploadToken` to `sessionToken` throughout the Encoding API codebase:

| Current | New | Format |
|---------|-----|--------|
| `uploadToken` | `sessionToken` | `sess_<32-char-hex>` |
| `SessionAuthGuard` | `SessionTokenGuard` | Accepts `Authorization: Bearer sess_...` |
| `PreviewAuthGuard` | Merged into `SessionTokenGuard` | Same guard handles all per-session auth |
| `tokenIndex` Map | `sessionTokenIndex` Map | `Map<tokenHash, sessionId>` |

Session token scope is extended from upload+preview to all per-session operations (upload, poll, encode start, preview).

### 4.3 Webhook URL Resolution

*Traces: Section 2.4 of URS*

When creating a session, the Encoding API determines the webhook URL:

```typescript
function resolveWebhookUrl(
    dto: CreateSessionDto,
    apiKey?: ApiKeyRecord,
): WebhookConfig | null {
    // 1. Per-session webhook takes precedence (web app flow)
    if (dto.webhook?.url) return dto.webhook;
    // 2. API key bound webhook (third-party flow)
    if (apiKey?.webhookUrl) return { url: apiKey.webhookUrl, sessionToken: '' };
    // 3. No webhook configured
    return null;
}
```

### 4.4 Encoding API Endpoints Summary

| Method | Path | Auth | New/Changed |
|--------|------|------|-------------|
| POST | `/api/keys` | JWT | **New** |
| GET | `/api/keys` | JWT | **New** |
| DELETE | `/api/keys/:keyId` | JWT | **New** |
| POST | `/api/sessions` | JWT or API Key | **Changed** — accepts API key, calls auth webhook |
| ALL | `/api/tus/*` | Session Token | **Changed** — renamed from uploadToken |
| POST | `/api/sessions/:id/encode` | JWT/API Key/Session Token | **Changed** — calls auth webhook |
| GET | `/api/sessions/:id` | JWT/API Key/Session Token | **Changed** — accepts all three auth types |
| GET | `/api/sessions/:id/preview/*` | Session Token | Unchanged |
| DELETE | `/api/sessions/:id` | JWT or API Key | **Changed** — accepts API key |

---

## 5. SaaS Service Design (Closed Source)

*Traces: FR-3.1, FR-3.2.3, FR-3.4–FR-3.8*

### 5.1 Service Structure

```
saas/
├── src/
│   ├── main.ts                       # NestJS bootstrap, CORS, Swagger
│   ├── app.module.ts                 # Root module
│   ├── auth/
│   │   ├── auth.module.ts            # JWT validation + identity resolution
│   │   ├── jwt.strategy.ts           # Auth0 JWT strategy (shared config with Encoding API)
│   │   ├── identity.service.ts       # User lookup by auth0Id/email, auth0Id linking
│   │   └── admin.guard.ts            # Role-based admin guard
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts       # Admin CRUD: /saas/admin/users/*
│   │   └── users.service.ts          # CouchDB user document CRUD
│   ├── keys/
│   │   ├── keys.module.ts
│   │   ├── keys.controller.ts        # /saas/keys (proxies to Encoding API)
│   │   └── keys.service.ts           # CouchDB key reference store + Encoding API proxy
│   ├── sessions/
│   │   ├── sessions.module.ts
│   │   ├── sessions.controller.ts    # /saas/sessions (history, import, estimate)
│   │   ├── sessions.service.ts       # CouchDB session history CRUD
│   │   └── import.service.ts         # HLS playlist parsing + S3 scanning for session import
│   ├── s3-configs/
│   │   ├── s3-configs.module.ts
│   │   ├── s3-configs.controller.ts  # /saas/s3-configs CRUD
│   │   └── s3-configs.service.ts     # CouchDB S3 config store + encryption
│   ├── webhooks/
│   │   ├── webhooks.module.ts
│   │   ├── encoding.controller.ts    # POST /saas/webhooks/encoding (session lifecycle)
│   │   ├── authorize.controller.ts   # POST /saas/webhooks/authorize (authorization)
│   │   └── webhook.service.ts        # Webhook payload processing, user resolution, CouchDB updates
│   ├── billing/
│   │   ├── billing.module.ts
│   │   ├── usage-meter.service.ts    # UsageMeterService interface + no-op implementation
│   │   ├── plan-limits.service.ts    # PlanLimitsService interface + permissive implementation
│   │   └── billing.service.ts        # BillingAccount CRUD
│   ├── admin/
│   │   ├── admin.module.ts
│   │   ├── dashboard.controller.ts   # GET /saas/admin/dashboard
│   │   └── dashboard.service.ts      # Aggregated stats queries
│   ├── signup/
│   │   ├── signup.module.ts
│   │   └── signup.service.ts         # SignupService interface + no-op implementation
│   └── database/
│       ├── database.module.ts        # CouchDB connection + nano client
│       ├── database.service.ts       # Generic CouchDB operations
│       └── indexes.ts                # Mango index definitions (created on startup)
├── scripts/
│   └── seed-admin.ts                 # CLI: npm -w saas run seed:admin --email ... --name ...
├── package.json
└── tsconfig.json
```

### 5.2 CouchDB Database Design

*Traces: Section 5 of URS*

#### 5.2.1 Database Initialization

On startup, the SaaS Service:

1. Connects to CouchDB using `COUCHDB_URL`
2. Creates the database (`COUCHDB_DATABASE`) if it does not exist
3. Creates all Mango indexes if they do not exist

```typescript
const INDEXES = [
    { name: 'sessions-by-user', fields: ['docType', 'userId', 'createdAt'] },
    { name: 'sessions-by-user-status', fields: ['docType', 'userId', 'status'] },
    { name: 'sessions-by-expiry', fields: ['docType', 'expiresAt'] },
    { name: 'users-by-email', fields: ['docType', 'email'] },
    { name: 'users-by-auth0id', fields: ['docType', 'auth0Id'] },
    { name: 'apikeys-by-user', fields: ['docType', 'userId', 'createdAt'] },
    { name: 'usage-by-user-period', fields: ['docType', 'userId', 'createdAt'] },
    { name: 'billing-by-user', fields: ['docType', 'userId'] },
    { name: 's3configs-by-user', fields: ['docType', 'userId', 'createdAt'] },
];
```

#### 5.2.2 Document Type Discrimination

All documents use a `docType` field. Every Mango query includes `docType` as the first selector to ensure type safety:

```typescript
// Example: find user by email
const result = await db.find({
    selector: { docType: 'user', email: 'user@example.com' },
    use_index: 'users-by-email',
    limit: 1,
});
```

### 5.3 Webhook Processing

*Traces: Section 2.4 of URS*

#### 5.3.1 Session Lifecycle Webhook Handler

```
POST /saas/webhooks/encoding

1. Validate webhook token (from X-Session-Token header)
2. Parse WebhookPayloadDto
3. Resolve userId:
   a. If payload contains apiKeyMetadata.userId → use directly
   b. If payload contains JWT sub/email → lookup user by auth0Id/email
   c. If neither → log warning, skip (orphan session)
4. Upsert session document in CouchDB:
   - If session document exists → update status, progress, error
   - If not exists → create new session document (first webhook for this session)
5. If terminal status (completed/failed):
   a. Compact session document (retain summary, S3 refs, encryption key, cost estimate)
   b. Record usage event via UsageMeterService
   c. If user has a forwarding webhook URL → forward the webhook
6. Return 200 OK
```

#### 5.3.2 Session Document Compaction

On completion webhook, the session document is rewritten:

```typescript
function compactSession(doc: ActiveSessionDoc, payload: CompletionPayload): CompletedSessionDoc {
    return {
        _id: doc._id,
        _rev: doc._rev,
        docType: 'session',
        userId: doc.userId,
        apiKeyId: doc.apiKeyId,
        status: 'completed',
        summary: {
            encodeType: payload.encodeType,
            renditionCount: payload.renditionCount,
            audioGroupCount: payload.audioGroupCount,
            sourceDurationSeconds: payload.sourceDurationSeconds,
            segmentFormat: payload.segmentFormat,
            encoder: payload.encoder,
        },
        s3ConfigId: doc.s3ConfigId ?? null,
        files: payload.files,
        masterPlaylist: payload.masterPlaylist,
        anglePlaylists: payload.anglePlaylists ?? null,
        thumbnailsVtt: payload.thumbnailsVtt ?? null,
        encryptionKey: payload.encryptionKey ?? null,
        costEstimate: payload.costEstimate,
        error: null,
        createdAt: doc.createdAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        expiresAt: computeExpiryDate(doc.userId),
    };
}
```

### 5.4 API Key Management

*Traces: FR-3.2.3*

The SaaS Service proxies key operations to the Encoding API and maintains a local reference in CouchDB.

#### 5.4.1 Key Creation Flow

```
POST /saas/keys { name: "Production" }

1. Resolve user from JWT
2. Call Encoding API: POST /api/keys (service JWT) with:
   - name: "Production"
   - webhookUrl: "https://saas.luminary.io/saas/webhooks/encoding"
   - authorizationUrl: "https://saas.luminary.io/saas/webhooks/authorize"
   - metadata: { userId: "<user-uuid>" }
3. Encoding API returns: { id, key, keyPrefix, createdAt }
4. Store reference in CouchDB:
   - { _id: "apikey:<id>", docType: "apikey", userId, name, keyPrefix, encodingApiKeyId: id }
   - Never store the full key
5. Return { id, key, name, keyPrefix, createdAt } to user
   - key is shown once and never stored
```

#### 5.4.2 Key Revocation Flow

```
DELETE /saas/keys/:keyId

1. Resolve user from JWT
2. Lookup key reference in CouchDB, verify ownership
3. Call Encoding API: DELETE /api/keys/:encodingApiKeyId (service JWT)
4. Delete key reference from CouchDB
5. Return 204 No Content
```

### 5.5 Session Import

*Traces: FR-3.4.8*

#### 5.5.1 Import Flow

```
POST /saas/sessions/import
{
    s3ConfigId: "<uuid>",
    masterPlaylistKey: "output/master.m3u8",  // or s3FolderPrefix
    encryptionKey: null
}

1. Resolve user from JWT
2. Load S3 config from CouchDB, decrypt credentials
3. Connect to S3 (MinIO client)
4. If masterPlaylistKey provided:
   a. Fetch the master.m3u8 file content from S3
5. If s3FolderPrefix provided:
   a. List objects under prefix with .m3u8 extension
   b. Identify master playlist (contains #EXT-X-STREAM-INF or #EXT-X-MEDIA)
   c. Fetch the master playlist content
6. Parse master playlist:
   a. Extract #EXT-X-STREAM-INF entries → video renditions (resolution, bandwidth)
   b. Extract #EXT-X-MEDIA entries → audio groups (language, name, group-id)
   c. Detect segment format: if #EXT-X-MAP present → fmp4, else → mpegts
   d. Detect encryption: if #EXT-X-KEY present → encrypted
   e. Count variant playlists → renditionCount
   f. Identify angle playlists (if URI patterns suggest multi-angle)
7. List all S3 objects under the path → file list, discover thumbnails VTT
8. Create completed session document in CouchDB:
   - status: "completed"
   - imported: true
   - summary from parsed data
   - files, masterPlaylist, anglePlaylists, thumbnailsVtt
   - encryptionKey (if provided by user)
   - s3ConfigId
   - No costEstimate (unknown for imported sessions)
9. Return { sessionId, status: "completed", summary }
```

#### 5.5.2 HLS Master Playlist Parser

```typescript
interface ParsedMasterPlaylist {
    renditions: Array<{
        bandwidth: number;
        resolution?: { width: number; height: number };
        codecs?: string;
        uri: string;
    }>;
    audioGroups: Array<{
        groupId: string;
        language?: string;
        name: string;
        uri: string;
    }>;
    segmentFormat: 'fmp4' | 'mpegts';
    encrypted: boolean;
    keyUri?: string;
}

function parseMasterPlaylist(content: string): ParsedMasterPlaylist;
```

### 5.6 Session Expiry

*Traces: FR-3.4.3*

A scheduled task runs on a configurable cron schedule (default: daily at 03:00):

```typescript
@Cron(process.env.SESSION_EXPIRY_CRON ?? '0 3 * * *')
async cleanupExpiredSessions(): Promise<void> {
    const now = new Date().toISOString();
    const expired = await db.find({
        selector: {
            docType: 'session',
            expiresAt: { $lt: now },
        },
        use_index: 'sessions-by-expiry',
    });

    for (const doc of expired.docs) {
        await db.destroy(doc._id, doc._rev);
    }

    logger.log(`Cleaned up ${expired.docs.length} expired sessions`);
}
```

### 5.7 Admin Seed Command

*Traces: FR-3.6.1*

```
npm -w saas run seed:admin -- --email admin@example.com --name "Admin User"

1. Connect to CouchDB
2. Check if a user with this email already exists → error if so
3. Create user document:
   {
       _id: "user:<uuid>",
       docType: "user",
       auth0Id: null,        // Linked on first login
       email: "admin@example.com",
       name: "Admin User",
       role: "admin",
       status: "active",
       emailVerifiedAt: new Date().toISOString(),
       createdAt: new Date().toISOString(),
       updatedAt: new Date().toISOString(),
   }
4. Create billing account document (free tier, 0% discount)
5. Log: "Admin user created. Sign in via Auth0 to link your account."
```

---

## 6. Billing & Cost Estimation Design

*Traces: FR-3.5.1–FR-3.5.8*

### 6.1 Billing Unit: Pixel-Minutes

The billing unit is **1080p30-equivalent minutes**:

```typescript
const REFERENCE_PIXELS_PER_FRAME = 1920 * 1080;
const REFERENCE_FPS = 30;
const REFERENCE_PPF = REFERENCE_PIXELS_PER_FRAME * REFERENCE_FPS;

function computePixelMinutes(
    durationMinutes: number,
    width: number,
    height: number,
    fps: number,
    copy: boolean,
): number {
    if (copy) return 0;
    return durationMinutes * (width * height * fps) / REFERENCE_PPF;
}
```

### 6.2 Cost Estimation Utility

Shared pure function in the `encode-config` package:

```typescript
function estimateEncodingCost(
    probeResult: ProbeResult,
    encodeConfig: EncodeConfig,
): CostEstimate {
    const durationMinutes = probeResult.format.duration / 60;
    const breakdown: CostBreakdownItem[] = [];
    let totalPixelMinutes = 0;
    let totalAudioMinutes = 0;
    let freeTierEligible = true;

    // Video renditions
    if (encodeConfig.type === 'video') {
        for (const rendition of encodeConfig.videoRenditions) {
            const fps = probeResult.videoTracks[0]?.frameRate ?? 30;
            const pm = computePixelMinutes(
                durationMinutes, rendition.width, rendition.height, fps, rendition.copy,
            );
            if (!rendition.copy) freeTierEligible = false;
            totalPixelMinutes += pm;
            breakdown.push({
                type: 'video', label: rendition.label ?? `${rendition.height}p`,
                width: rendition.width, height: rendition.height, fps,
                durationMinutes, pixelMinutes: pm, copy: rendition.copy,
            });
        }
    }

    // Audio groups
    for (const group of encodeConfig.audioGroups) {
        const am = group.copy ? 0 : durationMinutes;
        totalAudioMinutes += am;
        breakdown.push({
            type: 'audio', label: group.id,
            durationMinutes, copy: group.copy,
        });
    }

    return { pixelMinutes: totalPixelMinutes, audioMinutes: totalAudioMinutes, breakdown, freeTierEligible };
}
```

### 6.3 Plan Limits Service (Permissive Default)

```typescript
class PermissivePlanLimitsService implements PlanLimitsService {
    async canCreateSession(userId: string) { return { allowed: true }; }
    async canStartEncode(userId: string, config: EncodeConfig, estimate: CostEstimate) { return { allowed: true }; }
    async getMaxUploadSize(userId: string) { return 10 * 1024 ** 3; } // 10 GB
    async getMaxConcurrentSessions(userId: string) { return Infinity; }
    async getSessionRetentionDays(userId: string) { return 30; }
    async getRemainingFreeSourceMinutes(userId: string) { return Infinity; }
}
```

### 6.4 Usage Meter Service (No-Op Default)

```typescript
class NoOpUsageMeterService implements UsageMeterService {
    async recordSessionCreated(userId, sessionId) { logger.debug('usage:session_created', { userId, sessionId }); }
    async recordEncodingStarted(userId, sessionId, estimate) { logger.debug('usage:encoding_started', { userId, sessionId, estimate }); }
    async recordEncodingCompleted(userId, sessionId, stats) { logger.debug('usage:encoding_completed', { userId, sessionId, stats }); }
    async recordStorageUsed(userId, sessionId, bytes) { logger.debug('usage:storage_used', { userId, sessionId, bytes }); }
    async getUsageSummary(userId, periodStart, periodEnd) { return emptyUsageSummary(periodStart, periodEnd); }
}
```

---

## 7. Web App Design (Closed Source)

*Traces: Section 2.3 of URS*

### 7.1 Dual-Backend Communication

The web app talks to two services:

| Operation | Target | Auth |
|-----------|--------|------|
| Create session | Encoding API | JWT (Auth0) |
| Upload file (tus) | Encoding API | Session Token |
| Poll status | Encoding API | Session Token |
| Submit encode config | Encoding API | Session Token |
| Preview playback | Encoding API | Session Token |
| Session history | SaaS Service | JWT (Auth0) |
| API key management | SaaS Service | JWT (Auth0) |
| S3 config management | SaaS Service | JWT (Auth0) |
| Cost estimation | Client-side | N/A (pure function from `encode-config`) |
| Usage/billing info | SaaS Service | JWT (Auth0) |

### 7.2 Session Creation with Webhook Binding

When the web app creates a session on the Encoding API, it includes the SaaS Service's webhook URL:

```typescript
const session = await createSession(encodingApiUrl, {
    s3: selectedS3Config,
    webhook: {
        url: `${saasServiceUrl}/saas/webhooks/encoding`,
        sessionToken: await getWebhookToken(),
    },
    // ... other session options
}, accessToken);
```

### 7.3 Configuration

```
VITE_ENCODING_API_URL=https://encode.luminary.io
VITE_SAAS_SERVICE_URL=https://saas.luminary.io
VITE_AUTH0_DOMAIN=...
VITE_AUTH0_CLIENT_ID=...
VITE_AUTH0_AUDIENCE=...
```

---

## 8. Admin Panel Design (Closed Source)

*Traces: FR-3.6.1–FR-3.6.8*

### 8.1 Application Structure

```
admin/
├── src/
│   ├── main.ts                   # Vue app entry, Auth0 setup
│   ├── App.vue                   # Root component with admin role gate
│   ├── router.ts                 # Vue Router (dashboard, users, sessions, settings)
│   ├── api.ts                    # Fetch-based client for SaaS Service /saas/admin/* endpoints
│   ├── views/
│   │   ├── DashboardView.vue     # User counts, queue depth, recent activity
│   │   ├── UsersListView.vue     # Paginated user list with search/filter
│   │   ├── UserDetailView.vue    # User profile, sessions, API keys, usage, billing
│   │   ├── SessionsListView.vue  # Cross-user session browser
│   │   └── SettingsView.vue      # Global config (retention period, etc.)
│   └── components/
│       ├── UserForm.vue          # Create/edit user form
│       ├── SessionTable.vue      # Reusable session list table
│       └── UsageSummary.vue      # Usage/billing breakdown component
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### 8.2 Admin Role Gate

```typescript
// App.vue
const { user, isAuthenticated } = useAuth0();
const saasUser = ref(null);

onMounted(async () => {
    if (isAuthenticated.value) {
        saasUser.value = await fetchCurrentUser(accessToken);
        if (saasUser.value.role !== 'admin') {
            // Show "Access denied" message, no admin routes accessible
        }
    }
});
```

---

## 9. Security Design

*Traces: NFR-4.2.1–NFR-4.2.4*

### 9.1 API Key Hash Storage

```typescript
function hashApiKey(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
}
```

SHA-256 is used instead of bcrypt because API key validation is on the hot path (every request) and needs to be fast. The key itself is cryptographically random (32 bytes = 256 bits of entropy), so brute-force resistance from bcrypt is unnecessary.

### 9.2 S3 Credential Encryption

```typescript
const ALGORITHM = 'aes-256-gcm';

function encryptCredential(plaintext: string, encryptionKey: Buffer): EncryptedValue {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: authTag.toString('base64') };
}

function decryptCredential(encrypted: EncryptedValue, encryptionKey: Buffer): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return decipher.update(encrypted.data, 'base64', 'utf8') + decipher.final('utf8');
}
```

The `S3_CREDENTIAL_ENCRYPTION_KEY` environment variable provides the 32-byte key (hex or base64 encoded).

### 9.3 Audit Logging

Structured log entries for security-relevant actions:

```typescript
interface AuditLogEntry {
    timestamp: string;
    actorUserId: string;
    action: 'key.created' | 'key.revoked' | 'user.created' | 'user.disabled' | 'user.deleted' | 'user.role_changed' | 'session.deleted' | 'session.cleanup';
    targetId: string;
    metadata?: Record<string, unknown>;
}
```

Written to application log (structured JSON). Future: persist to CouchDB for queryable audit trail.

---

## 10. Testing Strategy

*Traces: NFR-4.4.1, NFR-4.4.2*

### 10.1 Coverage Requirement

All workspaces shall enforce **100% line and branch coverage**. Configuration:

**Vitest** is the sole test framework across all workspaces. Existing Jest tests in `api/` and `tusd/` shall be migrated to Vitest as part of Phase 1.

| Workspace | Framework | Coverage Config |
|-----------|-----------|-----------------|
| `api/` | Vitest | `coverage: { thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 } }` |
| `saas/` | Vitest | Same as above |
| `app/` | Vitest | Same as above |
| `admin/` | Vitest | Same as above |
| `encode-config/` | Vitest | Same as above |
| `tusd/` | Vitest | Same as above |

CI pipeline shall run `npm test -- --coverage` for all workspaces. PRs that reduce coverage below 100% fail the check.

### 10.2 Simulation Testing for External Processes

External binaries and services are never invoked in tests. All external dependencies are simulated.

#### 10.2.1 FFmpeg Simulation

```typescript
// Mock child_process.spawn for FFmpeg
vi.spyOn(child_process, 'spawn').mockImplementation((cmd, args) => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stderr = new Readable({
        read() {
            // Simulate progress output
            this.push('frame=100 fps=25 out_time_us=4000000 speed=2.5x\n');
            this.push(null);
        },
    });
    proc.stdout = new Readable({ read() { this.push(null); } });
    // Simulate successful exit after tick
    process.nextTick(() => proc.emit('close', 0));
    return proc;
});
```

**Test scenarios**:
- Correct FFmpeg argument construction (GPU modes, VBR, copy, audio groups, multi-angle, metadata)
- Progress parsing (out_time_us, out_time HH:MM:SS, percentage calculation)
- Error handling (non-zero exit code, stderr error messages, timeout/SIGTERM)
- Segment format detection (fMP4 vs MPEG-TS based on stream alignment)
- Byte-range consolidation (worker thread simulation)
- Master playlist post-processing (fixMasterPlaylist, generateAnglePlaylists)

#### 10.2.2 ffprobe Simulation

```typescript
// Mock child_process.execFile for ffprobe
vi.spyOn(child_process, 'execFile').mockImplementation((cmd, args, opts, cb) => {
    const probeOutput = {
        format: { duration: '120.5', bit_rate: '5000000', format_name: 'matroska' },
        streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, ... },
            { codec_type: 'audio', codec_name: 'aac', bit_rate: '128000', channels: 2, ... },
        ],
    };
    cb(null, JSON.stringify(probeOutput), '');
});
```

**Test scenarios**:
- Multi-strategy bitrate detection (bit_rate → BPS → NUMBER_OF_BYTES/DURATION → packet CSV)
- Multi-track media (multiple video tracks, multiple audio tracks with languages)
- Audio-only files (no video streams)
- Missing/malformed fields (graceful fallback)
- Stream start time detection (for segment format decision)

#### 10.2.3 Tusd Binary Simulation

```typescript
// Mock TusdServer internals — child process spawn + HTTP hook server
vi.spyOn(child_process, 'spawn').mockImplementation(() => {
    const proc = new EventEmitter() as ChildProcess;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    // Simulate tusd readiness
    process.nextTick(() => proc.stdout.write('[tusd] listening on port 12345\n'));
    return proc;
});
```

**Test scenarios**:
- Hook dispatching (onIncomingRequest, onUploadCreate, onUploadFinish, onProgress, onTerminate)
- Upload token/session token validation in incoming request hook
- File move/copy on upload finish
- Probe trigger after upload completion
- Expired upload cleanup
- Graceful shutdown (SIGTERM → SIGKILL fallback)

#### 10.2.4 S3 (MinIO Client) Simulation

```typescript
// Mock MinIO client methods
const mockMinioClient = {
    fPutObject: vi.fn().mockResolvedValue({}),
    listObjects: vi.fn().mockReturnValue(mockObjectStream),
    getObject: vi.fn().mockResolvedValue(mockReadableStream),
    bucketExists: vi.fn().mockResolvedValue(true),
};
```

**Test scenarios**:
- Parallel upload concurrency (5 workers default)
- Content type mapping (.m3u8, .m4s, .ts, .vtt, .webp)
- Upload progress callback accuracy
- Error handling (bucket not found, access denied, network timeout)
- Session import: S3 folder scanning, master playlist fetching, object listing

#### 10.2.5 CouchDB (nano) Simulation

```typescript
// Mock nano client
const mockDb = {
    find: vi.fn().mockResolvedValue({ docs: [] }),
    insert: vi.fn().mockResolvedValue({ ok: true, id: 'doc-id', rev: '1-abc' }),
    get: vi.fn().mockResolvedValue({ _id: 'doc-id', _rev: '1-abc', ... }),
    destroy: vi.fn().mockResolvedValue({ ok: true }),
    createIndex: vi.fn().mockResolvedValue({ result: 'created' }),
};
```

**Test scenarios**:
- Mango query construction (correct selectors, index usage, pagination)
- Document CRUD (insert, get, update with _rev, destroy)
- Conflict handling (409 on stale _rev)
- Index creation on startup
- Webhook upsert logic (create new doc vs update existing)
- Session document compaction

#### 10.2.6 Authorization Webhook Simulation

```typescript
// Mock fetch for authorization webhook calls
vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
    return new Response(JSON.stringify({ allowed: true }), { status: 200 });
});
```

**Test scenarios**:
- Allow response → operation proceeds
- Deny response → 403 with reason
- Timeout → fail-open (allow with warning) / fail-closed (403)
- Server error (5xx) → same as timeout
- Network error → same as timeout
- No authorization URL configured → skip (standalone mode)
- Per-key URL vs global URL precedence

#### 10.2.7 Encryption Simulation

Mock `crypto` operations and worker threads for `EncryptionService` tests:
- Key derivation (HMAC-SHA256 with seed)
- Segment encryption (AES-128-CBC)
- Worker thread message passing (progress events, completion, errors)
- Preview playlist rewriting (key URI substitution)

### 10.3 UI Testing Strategy

| Layer | Tool | Approach |
|-------|------|----------|
| **Component unit tests** | Vitest + Vue Test Utils | Mount individual components with mock props/inject. Test rendering, user interactions, emitted events |
| **Composable tests** | Vitest | Test composables in isolation (e.g., `useSessionPoller` with mocked fetch) |
| **API client tests** | Vitest | Mock `fetch`. Test request construction, response parsing, error handling |
| **Store/state tests** | Vitest | Test reactive state management logic |
| **Plugin tests** | Vitest + mock Video.js | Test quality selector and thumbnail preview plugins with mocked Video.js API |

---

## 11. Environment Configuration Summary

### 10.1 Encoding API (Changed & Added Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_ISSUER_URL` | (required) | OIDC issuer URL (replaces `AUTH0_DOMAIN`). Any OIDC provider. JWKS discovered via `/.well-known/openid-configuration` |
| `OIDC_AUDIENCE` | (required) | Expected JWT audience claim (replaces `AUTH0_AUDIENCE`) |
| `AUTHORIZATION_WEBHOOK_URL` | (none) | Global authorization webhook URL |
| `AUTHORIZATION_WEBHOOK_TIMEOUT_MS` | `5000` | Authorization webhook timeout |
| `AUTHORIZATION_WEBHOOK_FAIL_MODE` | `open` | `open` or `closed` |
| `API_KEY_RATE_LIMIT` | `100` | Requests per minute per API key |

### 10.2 SaaS Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | SaaS Service HTTP port |
| `COUCHDB_URL` | (required) | CouchDB connection URL |
| `COUCHDB_DATABASE` | `luminary` | CouchDB database name |
| `AUTH0_DOMAIN` | (required) | Auth0 tenant domain |
| `AUTH0_AUDIENCE` | (required) | Auth0 API audience |
| `ENCODING_API_URL` | (required) | Encoding API base URL (for key management proxy) |
| `ENCODING_API_JWT` | (required) | Service-level JWT for Encoding API key management |
| `S3_CREDENTIAL_ENCRYPTION_KEY` | (required) | AES-256 key for encrypting S3 credentials at rest |
| `SESSION_HISTORY_TTL_DAYS` | `30` | Default session history retention |
| `SESSION_EXPIRY_CRON` | `0 3 * * *` | Cron schedule for expired session cleanup |
| `FREE_TIER_MONTHLY_SOURCE_MINUTES` | `60` | Default free tier monthly source minutes cap |
| `AUTH0_SIGNUP_MODE` | `manual` | `manual` or `auto` (future) |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origins (web app + admin panel) |

### 10.3 Web App

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_ENCODING_API_URL` | (required) | Encoding API base URL |
| `VITE_SAAS_SERVICE_URL` | (required) | SaaS Service base URL |
| `VITE_AUTH0_DOMAIN` | (required) | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | (required) | Auth0 SPA client ID |
| `VITE_AUTH0_AUDIENCE` | (required) | Auth0 API audience |

### 10.4 Admin Panel

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_SAAS_SERVICE_URL` | (required) | SaaS Service base URL |
| `VITE_AUTH0_DOMAIN` | (required) | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | (required) | Auth0 admin SPA client ID |
| `VITE_AUTH0_AUDIENCE` | (required) | Auth0 API audience |

---

## 12. Implementation Phases

*Traces: Section 7 of URS*

### Phase 1 — SaaS Service & Encoding API Separation

| # | Task | Component | URS Ref |
|---|------|-----------|---------|
| 1.1 | Scaffold `saas/` NestJS workspace | SaaS Service | — |
| 1.2 | Implement CouchDB database module + Mango indexes | SaaS Service | FR-3.4.1 |
| 1.3 | Implement CLI seed command (`seed:admin`) | SaaS Service | FR-3.6.1 |
| 1.4 | Implement Auth0 JWT identity resolution (email matching, auth0Id linking) | SaaS Service | FR-3.1.1 |
| 1.5 | Add API key module (store, guard, CRUD endpoints) | Encoding API | FR-3.2.1, FR-3.2.2 |
| 1.6 | Add authorization webhook support | Encoding API | FR-3.2.4 |
| 1.7 | Rename `uploadToken` → `sessionToken`, extend scope | Encoding API | FR-3.3.2 |
| 1.8 | Implement webhook URL resolution (per-session + per-key) | Encoding API | Section 2.4 |
| 1.9 | Implement webhook receiver (`/saas/webhooks/encoding`) | SaaS Service | Section 2.4 |
| 1.10 | Implement authorization handler (`/saas/webhooks/authorize`) | SaaS Service | FR-3.2.4 |

### Phase 2 — Admin Panel & User Management

| # | Task | Component | URS Ref |
|---|------|-----------|---------|
| 2.1 | Implement `AdminGuard` | SaaS Service | FR-3.6.8 |
| 2.2 | Implement admin user CRUD endpoints | SaaS Service | FR-3.6.2, FR-3.6.3 |
| 2.3 | Implement admin session browsing + dashboard | SaaS Service | FR-3.6.5, FR-3.6.6 |
| 2.4 | Scaffold `admin/` Vue 3 SPA workspace | Admin Panel | FR-3.6.4 |
| 2.5 | Build admin views (users, sessions, dashboard) | Admin Panel | FR-3.6.4 |
| 2.6 | Admin API key revocation for any user | SaaS Service | FR-3.6.3 |

### Phase 3 — Session History & API Keys

| # | Task | Component | URS Ref |
|---|------|-----------|---------|
| 3.1 | Session document compaction on terminal status | SaaS Service | FR-3.4.4 |
| 3.2 | Session listing endpoint (paginated, filterable) | SaaS Service | FR-3.4.5 |
| 3.3 | Session expiry cron job | SaaS Service | FR-3.4.3 |
| 3.4 | S3 config CRUD endpoints + credential encryption | SaaS Service | FR-3.4.9, NFR-4.2.3 |
| 3.5 | API key management endpoints (proxy to Encoding API) | SaaS Service | FR-3.2.3 |
| 3.6 | Rate limiting middleware | Encoding API | FR-3.2.6 |
| 3.7 | Session import from S3 | SaaS Service | FR-3.4.8 |

### Phase 4 — Billing Interfaces & Open-Source Packaging

| # | Task | Component | URS Ref |
|---|------|-----------|---------|
| 4.1 | Billing document stubs + no-op usage meter | SaaS Service | FR-3.5.3, FR-3.5.4 |
| 4.2 | Permissive plan limits service | SaaS Service | FR-3.5.5 |
| 4.3 | Wire billing hooks into webhook receiver | SaaS Service | FR-3.5.6 |
| 4.4 | Signup service interface (no-op) | SaaS Service | FR-3.7.1 |
| 4.5 | `estimateEncodingCost()` shared utility | encode-config | FR-3.5.2.3 |
| 4.6 | Extract Video.js plugins to `@luminary/video-player` | app → video-player | Section 2.2 |
| 4.7 | Encoding API standalone documentation | Encoding API | NFR-4.4.2 |

### Phase 5 — Web App & Admin Dashboard

| # | Task | Component | URS Ref |
|---|------|-----------|---------|
| 5.1 | Dual-backend API client (Encoding API + SaaS Service) | Web App | Section 2.3 |
| 5.2 | Session history view (list, filter, sort, playback) | Web App | FR-3.4.5, FR-3.4.7 |
| 5.3 | Session import UI | Web App | FR-3.4.8 |
| 5.4 | API key management UI | Web App | FR-3.2.3 |
| 5.5 | S3 config management UI | Web App | FR-3.4.9 |
| 5.6 | Cost estimation display in EncodeConfigForm | encode-config | FR-3.5.2.2 |
| 5.7 | Account settings page | Web App | — |
| 5.8 | Usage dashboard | Web App | FR-3.5.4 |
