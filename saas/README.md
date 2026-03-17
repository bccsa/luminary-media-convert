# Luminary SaaS Service

Closed-source management layer for the Luminary encoding platform. Manages users, generates and stores API keys, creates encoding sessions on behalf of web app users, validates API keys via a webhook endpoint, stores session history, and provides admin endpoints. Built with NestJS and backed by CouchDB.

The SaaS Service does not proxy encoding operations -- clients talk to the Encoding API directly using session tokens. The SaaS Service stays informed of encoding activity via webhooks.

## Architecture

```
Web App ───JWT───> SaaS Service ──> CouchDB
Admin Panel ─JWT─►      |
                        |  Creates sessions via
                        |  master key (ENCODING_API_MASTER_KEY)
                        v
                  Encoding API
                   |         |
  Key validation   |         |  Webhooks (session status)
  webhook ─────────┘         v
                  SaaS Service webhook receiver
```

**Responsibilities:**

- User management (CRUD, disable/enable, role assignment)
- API key generation and storage (generates keys directly in CouchDB, not on the Encoding API)
- Key validation webhook endpoint (`POST /saas/webhooks/validate-key`) -- called by the Encoding API to validate API keys
- Session creation on behalf of web app users (`POST /saas/sessions`) -- calls the Encoding API with the master key, returns sessionToken to the web app
- Session history (receives webhooks from the Encoding API, stores session records in CouchDB)
- Authorization decisions (authorization webhook endpoint called by the Encoding API before session creation and encode start)
- Billing interfaces (future)

## CouchDB Setup

The SaaS Service requires a CouchDB instance. Install CouchDB and ensure it is running:

```bash
# macOS (Homebrew)
brew install couchdb && brew services start couchdb

# Docker
docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=password couchdb:3
```

The database and required indexes are created automatically on first startup.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP server port |
| `COUCHDB_URL` | No | `http://localhost:5984` | CouchDB connection URL |
| `COUCHDB_DATABASE` | No | `luminary` | CouchDB database name |
| `AUTH0_DOMAIN` | **Yes** | -- | Auth0 tenant domain |
| `AUTH0_AUDIENCE` | **Yes** | -- | Auth0 API identifier / audience |
| `ENCODING_API_URL` | **Yes** | -- | Encoding API base URL (for session creation on behalf of web app users) |
| `ENCODING_API_MASTER_KEY` | **Yes** | -- | Master key for the Encoding API (value of the Encoding API's `MASTER_API_KEY`) |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin |
| `ENABLE_SWAGGER` | No | `false` | Set to `true` to enable Swagger/OpenAPI docs at `/saas/docs` |

Example `saas/.env`:

```bash
PORT=3001
COUCHDB_URL=http://admin:password@localhost:5984
COUCHDB_DATABASE=luminary
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_AUDIENCE=https://luminary-media-convert/api
ENCODING_API_URL=http://localhost:3000
ENCODING_API_MASTER_KEY=my-secret-master-key
CORS_ORIGIN=http://localhost:5173
ENABLE_SWAGGER=true
```

## Seed Admin User

Before using the admin panel, seed an initial admin user:

```bash
npm run seed:admin -- --email admin@example.com --name "Admin User"
```

This creates an admin user document in CouchDB. The user's Auth0 account is linked automatically on first login via email matching.

## API Endpoints

Interactive Swagger/OpenAPI documentation is available at `/saas/docs` when the server is running.

### Admin - User Management

All endpoints require JWT authentication with the `admin` role.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/saas/admin/users` | Create a new user |
| GET | `/saas/admin/users` | List users (with pagination, search, role/status filters) |
| GET | `/saas/admin/users/:userId` | Get user details |
| PATCH | `/saas/admin/users/:userId` | Update user fields |
| POST | `/saas/admin/users/:userId/disable` | Disable a user account |
| POST | `/saas/admin/users/:userId/enable` | Enable a user account |
| DELETE | `/saas/admin/users/:userId` | Delete a user |

### Session Creation (Web App)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/sessions` | JWT | Create encoding session on Encoding API (master key), return sessionToken to web app |

### API Key Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/keys` | JWT | Generate API key (stored in CouchDB, full key returned once) |
| GET | `/saas/keys` | JWT | List user's API keys (prefix only) |
| DELETE | `/saas/keys/:keyId` | JWT | Revoke API key |

### Webhook Endpoints (called by Encoding API)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/saas/webhooks/validate-key` | (internal) | Validate API key, return metadata (userId, webhookUrl, authorizationUrl) |
| POST | `/saas/webhooks/encoding` | Webhook token | Receive session status webhooks from Encoding API |
| POST | `/saas/webhooks/authorize` | (internal) | Authorization webhook -- check user/plan limits |

### Future Endpoints

- Session history (list, detail, retention)
- Usage and billing

## Development

```bash
# Development mode with watch
npm -w saas run start:dev

# Production build
npm -w saas run build
npm -w saas run start:prod

# Tests
npm -w saas run test

# Seed admin user
npm -w saas run seed:admin -- --email admin@example.com --name "Admin User"
```

## Tech Stack

- Node.js with TypeScript
- NestJS 11 (Express platform)
- CouchDB via nano client
- Auth0 JWT validation via Passport + jwks-rsa
- class-validator + class-transformer for DTO validation
- Swagger/OpenAPI at `/saas/docs`
- Vitest for testing
