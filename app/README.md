# Luminary Web Application

Vue 3 single-page application for media encoding with a session-centric UI. Create, upload, configure, encode, and review -- everything is a session. Sessions persist in CouchDB and can be resumed at any point in the lifecycle.

## Architecture

The app follows a session-centric flow:

1. **Create** -- Start a new session (select S3 config, optional encryption/webhook settings)
2. **Upload** -- Resumable chunked file upload via tus protocol (50 MB chunks, 5 parallel uploads)
3. **Configure** -- Review probe results and configure encoding (video renditions, audio groups, copy/VBR toggles)
4. **Encode** -- Submit encoding config and monitor progress in real-time
5. **Review** -- HLS preview playback with quality selector and thumbnail scrubbing

## Backends

The web app talks to two independent services:

- **Encoding API** (via session token) -- File upload (tus), probe results, encoding, real-time status via SSE. The Encoding API URL comes from the SaaS Service (`/saas/me` endpoint), so no separate env var is needed.
- **SaaS Service** (via Auth0 JWT) -- Session creation (returns sessionToken + encodingApiUrl), API key management, S3 config management, session history, account settings

## Routes

| Path | Description |
|------|-------------|
| `/sessions` | Session list with status badges and real-time updates |
| `/sessions/new` | Create a new encoding session |
| `/sessions/import` | Import an existing session |
| `/sessions/:id` | Unified session view (upload, configure, encode, review) |
| `/keys` | API key management |
| `/s3-configs` | S3 storage configuration management |

## Key Components

- **SessionView** -- Unified lifecycle view that adapts to the current session status (upload, configure, encode, review)
- **HlsPlayer** -- Video.js 8 player with blob-based encrypted HLS playback
- **SessionConfigForm** -- S3 config selection, file picker, encryption/webhook options
- **EncodeConfigForm** -- Shared component from `encode-config` package (video renditions, audio groups, copy/VBR toggles)
- **ProgressBar** -- Encoding progress display
- **StatusBadge** -- Session status indicator
- **InlineConfirm** -- Confirmation UI for destructive actions

## Composables

- **useSessionPoller** -- Real-time session status via SSE with polling fallback, auto-stops on terminal status
- **useActiveUploads** -- Singleton tracker for in-progress tus uploads across the application

## Encrypted HLS Playback

Encrypted playback is handled entirely client-side. The app fetches HLS playlists from S3, rewrites `#EXT-X-KEY` URIs to point to a blob URL containing the raw key bytes (from the `encryptionKeyHex` field), and feeds the rewritten playlist to the player. This works on both Video.js (via hls.js) and Safari native HLS.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VITE_SAAS_SERVICE_URL` | **Yes** | SaaS Service base URL (e.g. `http://localhost:3001`) |
| `VITE_AUTH0_DOMAIN` | **Yes** | Auth0 tenant domain |
| `VITE_AUTH0_CLIENT_ID` | **Yes** | Auth0 SPA application Client ID |
| `VITE_AUTH0_AUDIENCE` | **Yes** | Auth0 API identifier / audience |

The Encoding API URL is obtained from the SaaS Service at runtime (`/saas/me` endpoint) -- no separate env var is needed.

Example `app/.env`:

```bash
VITE_SAAS_SERVICE_URL=http://localhost:3001
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-spa-client-id
VITE_AUTH0_AUDIENCE=https://luminary-media-convert/api
```

## PWA

The app is a Progressive Web App via [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/). The service worker precaches the built app shell (HTML, JS, CSS, icons) only — SaaS, Encoding API, Auth0, and tus traffic stay on the network.

- **Install:** `PwaInstallPrompt` captures the browser's `beforeinstallprompt` event and fires the **native install modal on the user's first interaction** with the page (the spec forbids triggering it without a user gesture). If the native modal cannot be shown, a fallback card with an Install button appears; iOS shows Share -> Add to Home Screen instructions. Requires a production build over HTTPS with an active service worker — not shown in dev (`devOptions.enabled: false`). Dismissal is remembered in localStorage.
- **Updates:** When a new build is deployed, `PwaUpdatePrompt` shows a reload banner; the page does not auto-reload (safe during long tus uploads).
- **Offline:** Cached shell may load without network, but uploads, encoding, and API calls still require connectivity.

Icons live in `app/public/` (source: `favicon.svg`). Regenerate after changing the logo:

```bash
npm -w app run generate:pwa-icons
```

**COOP/COEP headers** (for `SharedArrayBuffer` / future FFmpeg.wasm): set in dev via `vite.config.ts` `server.headers`; in production via `app/public/_headers` (copied to the build output for Cloudflare Workers static assets). Also disables edge caching of `sw.js` and `manifest.webmanifest`.

## Development

```bash
# Dev server (port 5173)
npm -w app run dev

# Production build
npm -w app run build

# Preview production build (Wrangler)
npm -w app run preview

# Tests
npm -w app run test
```

## Tech Stack

- Vue 3 (Composition API, `<script setup>`)
- Vite 6
- Tailwind CSS v4
- TypeScript
- Auth0 Vue SDK
- Video.js 8 with custom HLS quality selector and thumbnail preview plugins
- tus-js-client for resumable uploads
- vite-plugin-pwa (installable PWA, app-shell precache, update prompts)
- Vitest for testing
