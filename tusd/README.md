# node-tusd

Node.js wrapper for the Go [tusd](https://github.com/tus/tusd) binary. Provides a `TusdServer` class that spawns tusd as a child process, proxies HTTP requests, and dispatches lifecycle hooks (auth, upload create/finish, progress) via an internal HTTP hook server.

## Exports

- **`TusdServer`** -- Main class: spawns the tusd binary, manages its lifecycle, proxies incoming HTTP requests to tusd
- **`findTusdBinary`** -- Utility to locate the tusd binary using a 3-level fallback
- **Types** -- `TusdServerConfig`, `RequestInfo`, `UploadInfo`, `HookType`

## Binary Resolution

The tusd binary is resolved in this order:

1. `TUSD_BINARY_PATH` environment variable
2. Local `bin/tusd` within the package
3. System PATH

## Development

```bash
# Build the TypeScript source
npm -w tusd run build

# Download the tusd Go binary for the current platform
npm -w tusd run download-tusd
```

## Tech Stack

- Node.js with TypeScript (ES2023, ESM)
- Vitest for testing
