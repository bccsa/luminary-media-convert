# app/ — Vue web client (renderer)

## Overview

- **`app/`** — Vue 3 single-page client, the renderer of the desktop app: session list, local file pick, probe → encode config, trim/chapters authoring, preview and encoded playback. Served by the API itself in a packaged build, by Vite in development.

### Web Client (`app/`)

- **Framework**: Vue 3 (Composition API, `<script setup>`)
- **Build**: Vite 6, Tailwind CSS v4, TypeScript
- **Routing**: Vue Router 4 (history mode) — `/` → `/sessions`, `/sessions`, `/sessions/:id`
- **Auth**: no sign-in. The UI's credential is the instance API token, taken from the preload bridge in the desktop app and from `VITE_API_TOKEN` in browser development (`src/auth-token.ts`)
- **API base**: same-origin by default (the packaged app is served by the API); `VITE_API_URL` for browser development
- **Media playback**: `LuminaryPlayer` from `@luminary-media-converter/player-web` (Video.js 10 / hls.js, driven by the `player-core` controller) with a bare windowed frame (`controls.windowedControls: false`): the trim timeline and its shortcuts are the whole transport, and fullscreen — the app's button beside the selectors, or a double-click on the picture — shows the player's own controls. Angle switching, quality selection, audio tracks and encrypted playback all go through the controller; the AES key is fetched masked from `GET /api/sessions/:id/key`, unmasked in memory (`utils/keyMask.ts`) and handed to the player, which serves it to hls.js from memory through its loader — no key blob URLs
- **Shared packages**: `@luminary-media-converter/encode-config`, `@luminary-media-converter/hls-core`, `@luminary-media-converter/player-core`, `@luminary-media-converter/player-web`
- **Real-time updates**: SSE via `GET /api/sessions/:id/events`, with a polling fallback in `useSessionPoller`
- **Testing**: Vitest + `@vue/test-utils` + jsdom

### Segment Editor (`app/src/components/segment-editor/`)

- A folder inside the web client, not a workspace. It was a published library while it might have had other hosts; `app` is its only consumer, so it is source now and imported by relative path through its `index.ts`
- Exports `SegmentEditor`, `Segment` / `SegmentEditorMode` types, WebVTT helpers and time helpers
- Modes: `trim` (no labels, no overlap), `chapters` (labels, no overlap, ripple edit), `subtitles` (labels, overlap allowed)
- Player-agnostic: consumers pass `getCurrentTime()` and optional `onSeek` / `onPlayPause`
- Keyboard: `keyboard-scope="global"` (the trim timeline) listens on `window`. While the page is fullscreen the editor is out of view, so it answers only transport keys — Space/K, J/L, ←/→, Home/End, `,`/`.`, held 1/2/3 — and ignores the editing ones (marks, cuts, Alt+arrows, undo, zoom, Esc, `?`). In fullscreen the global scope also listens in the capture phase, so a focused video.js control can neither swallow a transport key nor act on it a second time; an open menu inside the player keeps its own keys
- Carries its own `styles.css`, imported by the component itself
- Testing: its 225 specs moved with it and run in `app`'s suite. The library's own coverage thresholds (100% lines) did not survive the move — `app` has no per-directory thresholds

### Environment (`app/.env`)


| Variable         | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `VITE_API_URL`   | Base URL of the local API. Empty in the packaged app (same origin)     |
| `VITE_API_TOKEN` | Stands in for the preload bridge token when running in a plain browser |

## Project Structure (`app/`)

```
app/
├── src/
│   ├── main.ts                          # Vue app entry (router only — no auth provider)
│   ├── App.vue                          # Shell: primary nav + appearance menu
│   ├── router.ts                        # /sessions, /sessions/:id
│   ├── api.ts                           # Fetch client for the local API (X-API-Key or session Bearer)
│   ├── auth-token.ts                    # Preload bridge token, else VITE_API_TOKEN
│   ├── session-tokens.ts                # Session token map seeded from GET /api/sessions
│   ├── types.ts                         # App types + re-exports from encode-config
│   ├── components/
│   │   ├── AppPrimaryNav.vue, AccountMenu.vue   # nav shell; the "account" menu is now appearance/theme only
│   │   ├── FileDropZone.vue             # Drop / pick a local file (paths via the preload bridge)
│   │   ├── ProgressBar.vue, StatusBadge.vue, FormSelect.vue, FormSelectListbox.vue
│   │   ├── ConfirmDangerModal.vue, DeleteSessionModal.vue
│   │   └── session-view/
│   │       ├── SessionWorkflowPanel.vue      # Probe → encode config → start
│   │       ├── SessionTrimWorkspace.vue      # Trim timeline (waveform, storyboard, zoom, cuts)
│   │       ├── SessionPlayerStrip.vue        # LuminaryPlayer + angle/quality/audio selectors (usePlayerState)
│   │       ├── SessionPostProcessPanel.vue   # Chapters authoring
│   │       └── SessionOutputPanel.vue        # Output summary / playback URLs
│   ├── composables/
│   │   ├── useSessionPoller.ts          # SSE with polling fallback, stops on terminal status
│   │   ├── useChapters.ts               # Chapter load/save (localStorage draft + debounced write to the API)
│   │   ├── useChapterTrimSync.ts, useTrimDeletions.ts, useTrimPlayback.ts, useTrimmedStoryboard.ts
│   │   └── useStoryboard.ts, useEncodeEta.ts, useAppLayout.ts, useTheme.ts
│   ├── utils/                           # errors, format, status, storyboardVtt, trimPlayback, trimTimeline, keyMask
│   └── views/
│       ├── ActiveSessionsView.vue       # Session list (polls GET /api/sessions)
│       └── SessionView.vue              # Full session lifecycle
└── vite.config.ts                       # Port 5173, strictPort, Vitest config
```

Also: `app/src/components/segment-editor/{index,SegmentEditor.vue,types,time,vtt,thumbnailVtt,styles.css}`

## Detail

- `docs/claude/development.md` — dev workflows
- `docs/claude/player.md` — player contract the client consumes
