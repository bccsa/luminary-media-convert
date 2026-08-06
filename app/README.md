# Luminary Web Client

The Vue 3 single-page app that is the renderer of the desktop application. It talks to the local Encoding API and nothing else — there is no sign-in, no account, and no remote backend.

In a packaged build the API serves this app's `dist/` at `/`, so requests are same-origin. In development it runs on Vite's own port and reaches the API across origins.

## Flow

Sessions are opened by the Luminary CMS, not here — this app has no "new session" affordance, because it has nowhere to get an S3 destination or a public base URL from. What it does is everything after that:

1. **List** (`/sessions`) — every session on this instance, polled every 3 s, with status and progress. Session tokens come down with the list, which is what seeds the map the detail view reads (so a deep link that lands cold can just ask for the list).
2. **Pick a file** (`/sessions/:id`) — drop or browse for a local file. The real path comes from the preload bridge (`window.luminary.getPathForFile` / `showOpenDialog`) and is sent to `POST /api/sessions/:id/local-file`. The file is read where it sits; nothing is uploaded through the browser.
3. **Trim** — waveform, storyboard frames and zoomable timeline, backed by the API's source waveform and storyboard endpoints. Cuts become `trimSegments` on the encode config.
4. **Configure** — `EncodeConfigForm` from `@luminary-media-converter/encode-config` computes a suggested ladder from the probe results; the user adjusts renditions, audio groups, copy/VBR.
5. **Encode** — progress over SSE with a polling fallback.
6. **Review** — preview player during, encoded HLS playback (with angle and audio-track selection) after, plus chapter authoring written back as `chapters/<lang>.vtt`.

## Authentication

There is none, in the user-facing sense. The app's credential for the local API is the **instance API token**:

- In the desktop app, the main process mints it per launch and hands it over the preload bridge (`window.luminary.getApiToken()`). It is never written to disk and never embedded in the bundle.
- In a plain browser, `VITE_API_TOKEN` stands in for it.

Per-session routes (preview, waveform, storyboard) use the session's own `sess_*` token instead, passed as a `?token=` query parameter where the browser cannot set headers.

## Routes

| Path | View |
|---|---|
| `/` | redirects to `/sessions` |
| `/sessions` | `ActiveSessionsView` — session list |
| `/sessions/:id` | `SessionView` — the whole session lifecycle |

## Key components

- **`SessionView`** — orchestrates the lifecycle; composed of `SessionWorkflowPanel` (probe → config → start), `SessionTrimWorkspace` (trim timeline), `SessionPlayerStrip` (player + track/quality selectors), `SessionPostProcessPanel` (chapters), `SessionOutputPanel` (output summary)
- **`HlsPlayer`** — Video.js 8, client-side decryption of encrypted HLS, chapter cue injection. Player-reported duration is treated as authoritative over the source probe duration, so cue positions match the actual stream
- **`FileDropZone`** — drop / browse, resolving real paths through the preload bridge
- **`AccountMenu`** — no account any more; it keeps its place and carries the theme setting

## Composables

- **`useSessionPoller`** — SSE with a polling fallback, auto-stops on a terminal status
- **`useChapters`** — chapter load/save: localStorage draft plus a debounced write to `PUT /api/sessions/:id/chapters`
- **`useStoryboard` / `useTrimmedStoryboard`** — storyboard VTT fetch and re-timing onto the trimmed timeline
- **`useTrimDeletions` / `useTrimPlayback` / `useChapterTrimSync`** — trim editing, preview playback across cuts, keeping chapters aligned with trims
- **`useEncodeEta`**, **`useAppLayout`**, **`useTheme`**

## Encrypted HLS playback

Handled entirely client-side. The app fetches the playlists, replaces the `#EXT-X-KEY` URI — `luminary://key` for locally generated keys — with a blob URL containing the raw key bytes decoded from `encryptionKeyHex`, and feeds the rewritten playlist to the player. Multi-angle masters are narrowed with `listVideoAngles` / `extractAnglePlaylist` / `extractAudioOnlyPlaylist` from `@luminary-media-converter/hls`.

## Environment Variables

Only needed for browser development. The packaged app needs none: the API serves the client, so the base URL is empty (same origin) and the token comes from the bridge.

| Variable | Description |
|---|---|
| `VITE_API_URL` | Base URL of the local Encoding API, e.g. `http://127.0.0.1:3000` |
| `VITE_API_TOKEN` | Stands in for the preload bridge token; must match the API's `MASTER_API_KEY` |

Example `app/.env`:

```bash
VITE_API_URL=http://127.0.0.1:3000
VITE_API_TOKEN=dev-token
```

Browser dev has no preload bridge, so a dropped file cannot be resolved to a real path — the file-pick step only works inside the Electron shell.

## Development

```bash
npm -w app run dev      # Vite dev server on port 5173 (strictPort)
npm -w app run build    # builds the shared libraries, type-checks, then builds
npm -w app run preview  # build + preview
npm -w app run test     # Vitest
```

Some specs were intentionally left broken during the local-only migration (`api.spec.ts` still exercises a `createSession` helper that no longer exists) — tracked in [`../Todo.md`](../Todo.md).

## Tech Stack

- Vue 3 (Composition API, `<script setup>`)
- Vite 6, Tailwind CSS v4, TypeScript
- Vue Router 4 (history mode)
- Video.js 8 with custom HLS quality selector and thumbnail preview plugins (`resolve.dedupe: ['video.js']` keeps a single instance)
- `@luminary-media-converter/{encode-config,segment-editor,hls}`
- Vitest + `@vue/test-utils` + jsdom
