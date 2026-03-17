# Luminary Media Convert

Monorepo containing an open-source HLS/ABR encoding API and a closed-source SaaS platform for multi-user media encoding. The Encoding API runs standalone on GPU-equipped hardware, while the SaaS layer adds user management, API key management, session history, and billing interfaces via a separate service backed by CouchDB.

## System Architecture

```
                  Web App (SPA)              Admin Panel (SPA)
                  app/                       admin/
                  port 5173                  port 5174
                       |                          |
            Session token                    JWT (admin-only)
            (from SaaS)                           |
                       |   JWT (Auth0)            |
                       |   for SaaS ──────────────|
                       v                          v
                  Encoding API              SaaS Service
                  api/                      saas/
                  port 3000                 port 3001
                  (open source)             (closed source)
                       ^                     |         ^
                       |                     |         |
                  API key (validated    Creates sessions   Key validation
                  via SaaS webhook)     via master key     webhook
                       |
              Third-Party Services
```

**Encoding API** -- Stateless, open-source encoding service. Accepts master key or webhook-validated API key authentication. Creates sessions, receives file uploads via tus, probes media, encodes to HLS/ABR with FFmpeg (GPU-accelerated when available), uploads output to S3-compatible storage, and delivers status updates via webhooks. Has no key store and no `/api/keys` endpoints.

**SaaS Service** -- Closed-source management layer. Manages users, generates and stores API keys, creates sessions on behalf of web app users (master key), validates API keys via webhook endpoint, stores session history in CouchDB, and exposes admin endpoints. Does not proxy encoding -- clients talk to the Encoding API directly using session tokens.

## Monorepo Structure

| Workspace | Description | License | README |
|-----------|-------------|---------|--------|
| `api/` | Encoding API -- HLS/ABR encoding service | Apache 2.0 | [api/README.md](api/README.md) |
| `app/` | Web Application -- Vue 3 SPA for uploading and encoding | Proprietary | [app/README.md](app/README.md) |
| `admin/` | Admin Panel -- Vue 3 SPA for system administration | Proprietary | [admin/README.md](admin/README.md) |
| `saas/` | SaaS Service -- User management, API keys, session history | Proprietary | [saas/README.md](saas/README.md) |
| `encode-config/` | Shared encoding config component and types | Apache 2.0 | [encode-config/README.md](encode-config/README.md) |
| `tusd/` | Node.js wrapper for the Go tusd binary | MIT | [tusd/README.md](tusd/README.md) |

## Prerequisites

- **Node.js** >= 18
- **FFmpeg** (with `libx264` and `aac`; optional GPU encoders: `h264_nvenc` for NVIDIA, `h264_videotoolbox` for Apple Silicon)
- **CouchDB** (required for the SaaS Service)
- **Auth0 account** (required for the web app, admin panel, and SaaS Service)

## Quick Start

```bash
# Install all dependencies (hoisted via npm workspaces)
npm install

# Start all services in development mode
npm run dev
```

This starts:

| Service | URL |
|---------|-----|
| Encoding API | `http://localhost:3000` (docs at `/api/docs`) |
| SaaS Service | `http://localhost:3001` (docs at `/saas/docs`) |
| Web Application | `http://localhost:5173` |
| Admin Panel | `http://localhost:5174` |
| encode-config | Watch build (library mode) |

## Seed Admin User

Before using the admin panel, seed an initial admin user in CouchDB:

```bash
npm run seed:admin -- --email admin@example.com --name "Admin User"
```

The admin user's Auth0 account is linked automatically on first login via email matching.

## Documentation

- [Encoding API Reference](api/README.md) -- Full API documentation, authentication, webhooks, encoding workflow
- [Web Application](app/README.md) -- Client setup and environment variables
- [Admin Panel](admin/README.md) -- Admin features and role setup
- [SaaS Service](saas/README.md) -- CouchDB setup, admin endpoints, seed commands
- [User Requirements Specification](docs/URS-saas-adaptation.md)
- [Functional Design Specification](docs/FDS-saas-adaptation.md)
- [Implementation Plan](docs/implementation-plan.md)
