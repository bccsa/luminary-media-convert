# Luminary Media Convert — Project Context

A local-only desktop media encoder, as a folder-based npm workspaces monorepo. This file is deliberately short: it loads on every request.
Each workspace has its own `CLAUDE.md`, loaded when you work inside that folder; longer reference lives in `docs/claude/` and is read on demand (plain references, not imports).

## Workspaces

| Folder | What it is |
|---|---|
| `api/` | NestJS "Encoding API": FFmpeg → HLS/ABR, S3 upload, SSE/polling, preview, CMS handshake, HLS-edit. Embeddable via `createServer()` in `api/src/bootstrap.ts` |
| `app/` | Vue 3 renderer: sessions, file pick, probe → encode config, trim/chapters, preview and playback |
| `app-electron/` | Electron shell hosting the API in-process; mac (dmg/zip) and Windows (NSIS) packaging |
| `cms-mock/` | Dev-only stand-in for the Luminary CMS (port 5199) |
| `encode-config/` | Shared `EncodeConfigForm` component and encode/probe types |
| `hls-core/` | Lossless HLS playlist parser/builder, LMCENC helpers, angle extraction |
| `player-core/` | Headless player wrapper: munging pipeline, `PlayerController`, `PlayerAdapter` contract |
| `player-web/` | Simple web player on Video.js 10 / hls.js: the browser engine plus a `LuminaryPlayer.vue` on the stock skin (encoder and CMS previews). The Luminary app's full player UI lives in the Luminary repo |
| `player-native/` | Native (Capacitor) player adapters for Android/iOS, the lab app in `example-app/`. No section in the old CLAUDE.md; see its own `temp_native-player-*.md` notes |

There is **no** SaaS service, admin panel, Auth0, CouchDB, tus upload server, webhook delivery, or PWA/Cloudflare deployment. Those workspaces (`saas/`, `admin/`, `tusd/`) were removed in the local-only migration.

## Monorepo Structure

- Root `package.json` declares npm workspaces (`"workspaces": ["api", "app", "encode-config", "hls-core", "player-core", "player-web", "cms-mock", "app-electron"]`)
- Dependencies are hoisted to the root `node_modules/`
- Run workspace scripts from root: `npm -w api run <script>` or `npm -w app run <script>`
- Root `npm run dev` — browser development: builds the shared libraries, then runs their watch builds (each Vue library watches JS and `.d.ts` side by side, so a type-check during dev is not left staring at a `dist` with no declarations), the API dev server and the Vite web client concurrently
- Root `npm run dev:electron` — desktop development: same watch builds plus a compiled API build, the Vite web client, and the Electron shell pointed at it

## Where the detail went

Split from this file on 2026-10-12 to cut per-request context. Nothing was dropped; sections moved verbatim.

- `docs/claude/api-architecture.md` — sessions, CMS contract, trust model, LNA/PNA, credentials, encoding pipeline and features, preview, persistence, lifecycle
- `docs/claude/api-reference.md` — endpoints, API environment variables
- `docs/claude/api-conventions.md`, `docs/claude/api-structure.md` — API conventions and file layout
- `docs/claude/player.md` — the `luminary://key` player contract and the player conventions
- `docs/claude/ffmpeg.md` — FFmpeg requirement, GPU detection
- `docs/claude/development.md` — dev workflows, `ELECTRON_RUN_AS_NODE` gotcha, exercising the CMS flow
- `docs/claude/packaging.md` — electron-builder, ffmpeg binaries, signing

## Follow-ups

Known gaps and deferred work are tracked as [issues](https://github.com/bccsa/luminary-media-convert/issues). Notably: CMS edit mode for existing collections (#205 — `existingMedia` is accepted and ignored), auto-update and code signing (#206), Linux builds (#207), storage that is never reclaimed when a document is deleted or a collection superseded (#208), and Windows build verification (#209).
