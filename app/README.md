# Luminary Web Application

Vue 3 single-page application for uploading media files, configuring HLS/ABR encoding, and monitoring encoding sessions. Communicates directly with the Encoding API for session operations and with the SaaS Service for user context, API key management, and session history.

## Backends

The web app talks to two independent services:

- **Encoding API** (via session token) -- File upload (tus), probe results, encoding, polling, preview playback. The web app obtains a session token from the SaaS Service (which creates the session on the Encoding API using the master key) and uses it for all per-session operations directly on the Encoding API.
- **SaaS Service** (via Auth0 JWT) -- Session creation (returns sessionToken + encodingApiUrl), API key management, session history, S3 config management, account settings

## Features

- Auth0 login (Universal Login redirect flow)
- Drag-and-drop file upload with browse fallback
- Resumable chunked file upload via the tus protocol (50 MB chunks, 5 parallel uploads)
- Probe result display showing detected video and audio tracks with editable metadata (names, languages)
- Configurable encoding settings via the shared `EncodeConfigForm` component (video renditions with ABR ladder suggestions, audio groups with quality tiers, copy/re-encode toggles, VBR/CBR)
- Encode config persistence (previous configs for the same media layout saved to localStorage)
- S3 storage configuration (persisted to localStorage)
- Optional webhook and encryption configuration
- Real-time session progress via polling with status badges and progress bar
- HLS media preview with Video.js player, ABR quality selector, and thumbnail scrubbing
- Multi-angle video switching
- Encoder and segment format badges
- Copy S3 URL to clipboard

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VITE_ENCODING_API_URL` | **Yes** | Encoding API base URL (e.g. `http://localhost:3000`) |
| `VITE_SAAS_SERVICE_URL` | **Yes** | SaaS Service base URL (e.g. `http://localhost:3001`) |
| `VITE_AUTH0_DOMAIN` | **Yes** | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | **Yes** | Auth0 SPA application Client ID |
| `VITE_AUTH0_AUDIENCE` | **Yes** | Auth0 API identifier / audience |

Example `app/.env`:

```bash
VITE_ENCODING_API_URL=http://localhost:3000
VITE_SAAS_SERVICE_URL=http://localhost:3001
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-spa-client-id
VITE_AUTH0_AUDIENCE=https://luminary-media-convert/api
```

## Development

```bash
# Dev server (port 5173)
npm -w app run dev

# Production build
npm -w app run build

# Tests
npm -w app run test
```

## Tech Stack

- Vue 3 (Composition API, `<script setup>`)
- Vite 6
- Tailwind CSS v4
- TypeScript
- Video.js 8 with custom HLS quality selector and thumbnail preview plugins
- tus-js-client for resumable uploads
- Auth0 Vue SDK
- Vitest for testing
