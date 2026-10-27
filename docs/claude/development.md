# Development workflows (detail)

## Development Workflows

### Browser development (fastest loop, no Electron)

```bash
npm install
npm run dev
```

Starts the shared-library watch builds, the API on `http://127.0.0.1:3000` (Swagger at `/api/docs`), and the web client on `http://localhost:5173`.

`api/.env`:

```bash
LOCAL_API_TOKEN=dev-token
# Every browser page that calls the API needs an entry — including the web
# client itself. In Electron it is same-origin and sends no Origin header, so
# it needs none there; in browser dev it is a cross-origin page like any other
# and is refused without this (there is no approver dialog outside Electron).
CMS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5199
```

`app/.env`:

```bash
VITE_API_URL=http://127.0.0.1:3000
VITE_API_TOKEN=dev-token
```

`VITE_API_URL` and the API's `PORT` have to agree; Electron's own default is `31711` (`DEFAULT_PORT` in `api/src/bootstrap.ts`), so setting `PORT` to that lets one `app/.env` serve both modes — at the cost of not being able to run `dev` and `dev:electron` at once.

Browser dev has no preload bridge, so a dropped file cannot be resolved to a real path — the local-file flow only works inside the Electron shell.

### Desktop development

```bash
npm run dev:electron
```

Builds the shared libraries and the API, then runs the Vite client and Electron together. The main process retries the renderer URL for 30 s, because Vite is routinely a few seconds behind Electron.

**Gotcha — `ELECTRON_RUN_AS_NODE`.** Some parent processes (VS Code's integrated terminal, agent runners) export `ELECTRON_RUN_AS_NODE=1`. With it set, `electron .` runs as a plain Node process: no window ever appears and none of the `app` / `BrowserWindow` code runs. If the desktop app "starts and does nothing", check `env | grep ELECTRON` and `unset ELECTRON_RUN_AS_NODE` first.

### Exercising the CMS flow

```bash
npm -w cms-mock run dev     # http://localhost:5199
```

Run it against a running API (default `http://127.0.0.1:31711`, editable in the UI). Its origin differs from the API's on purpose, so the real CORS / origin-gating path is exercised — in the desktop app the first request raises the native approval dialog. It walks health → create session → SSE console (highlighting the first event carrying `hlsUrl`, pinned in `MediaDto` shape) → playback check (angle extraction and the `luminary://key` substitution). Defaults assume a local MinIO with an anonymously readable `media` bucket.
