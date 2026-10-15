# cms-mock/ — dev-only CMS stand-in

## Overview

- **`cms-mock/`** — Dev-only Vue 3 app standing in for the Luminary CMS, so the whole CMS → encoder flow (origin gating, `documentId` reuse, `hlsUrl`/key delivery, `luminary://key` substitution, angle extraction) can be exercised locally. Not shipped; nothing depends on it.

### CMS Mock (`cms-mock/`)

- Vue 3 + Vite, runs on port **5199** deliberately: a different origin from the API, so every request goes through the real CORS / origin-gating path
- Panels: connection (`GET /api/cms/health`), create session (`POST /api/cms/sessions`), SSE console, playback check (fetches `hlsUrl`, lists angles, renders extracted single-angle and audio-only playlists, previews the `luminary://key` substitution)
- Form values persist to `localStorage`; defaults are prefilled for a local MinIO

## Project Structure (`cms-mock/`)

```
cms-mock/
├── src/
│   ├── App.vue, main.ts, store.ts, types.ts
│   └── components/{ConnectionPanel,CreateSessionPanel,EventConsole,PlaybackCheck}.vue
├── README.md
└── vite.config.ts                       # Port 5199
```

See `docs/claude/development.md` ("Exercising the CMS flow") and `docs/claude/api-architecture.md` ("The CMS contract").
