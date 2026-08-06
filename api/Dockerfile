# syntax=docker/dockerfile:1.7
# Build context: repo root. Build: `docker build -f api/Dockerfile . -t lmc-api`

# ---------- Builder ----------
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .

RUN npm ci \
 && npm -w hls run build \
 && npm -w api run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# ---------- Runtime ----------
FROM node:22-bookworm-slim

# ffmpeg/ffprobe for media processing; tini for clean PID 1 signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Hoisted root node_modules contains all workspaces' production deps plus
# workspace symlinks (@luminary-media-converter/hls -> ../hls). We must preserve
# those sibling target paths alongside the symlinks for module resolution to
# work.
COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/api/package.json ./api/package.json
COPY --from=builder /repo/api/dist ./api/dist
COPY --from=builder /repo/hls/package.json ./hls/package.json
COPY --from=builder /repo/hls/dist ./hls/dist

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "api/dist/main"]
