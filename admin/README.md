# Luminary Admin Panel

Vue 3 single-page application for system administration. Connects to the SaaS Service only. Access is restricted to users with the `admin` role, which is managed by the SaaS Service in CouchDB (not by Auth0). Auth0 is used solely for authentication (verifying identity).

## Features

- **User management** -- Create, view, edit, disable, enable, and delete users
- **Dashboard** -- System overview (placeholder)
- **Session browsing** -- View encoding sessions across all users (placeholder)

## Backends

The admin panel communicates with a single backend:

- **SaaS Service** (via JWT) -- All admin operations (`/saas/admin/*` endpoints)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VITE_SAAS_SERVICE_URL` | **Yes** | SaaS Service base URL (e.g. `http://localhost:3001`) |
| `VITE_AUTH0_DOMAIN` | **Yes** | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | **Yes** | Auth0 SPA application Client ID (can share with the web app or use a separate one) |
| `VITE_AUTH0_AUDIENCE` | **Yes** | Auth0 API identifier / audience |

Example `admin/.env`:

```bash
VITE_SAAS_SERVICE_URL=http://localhost:3001
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-admin-client-id
VITE_AUTH0_AUDIENCE=https://luminary-media-convert/api
```

## Admin Role

The admin role is managed entirely by the SaaS Service in CouchDB — no Auth0 role configuration is needed. When a user logs in via Auth0, the SaaS Service looks up their user document in CouchDB and checks the `role` field.

To create the first admin user, run the seed command:

```bash
npm run seed:admin -- --email admin@example.com --name "Admin User"
```

This creates a user document with `role: admin` in CouchDB. When that person logs in via Auth0, the SaaS Service matches by email and grants admin access. Additional admins can be created via the admin panel's user management interface.

## Development

```bash
# Dev server (port 5174)
npm -w admin run dev

# Production build
npm -w admin run build

# Tests
npm -w admin run test
```

## Tech Stack

- Vue 3 (Composition API, `<script setup>`)
- Vite 6
- Vue Router 4
- Tailwind CSS v4
- TypeScript
- Auth0 Vue SDK
- Vitest for testing
