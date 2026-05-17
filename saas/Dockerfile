# syntax=docker/dockerfile:1.7
# Build context: repo root. Build: `docker build -f saas/Dockerfile . -t lmc-saas`

# ---------- Builder ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /repo
COPY . .

RUN npm ci \
 && npm -w hls run build \
 && npm -w saas run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# ---------- Runtime ----------
FROM node:22-bookworm-slim

# tini: clean PID 1 signal handling.
# ca-certificates: HTTPS to CouchDB / S3 / Auth0 JWKS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Hoisted root node_modules contains all workspaces' production deps plus the
# workspace symlink @luminary-media-converter/hls -> ../hls. We must preserve
# the sibling target path alongside the symlink.
COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/saas/package.json ./saas/package.json
COPY --from=builder /repo/saas/dist ./saas/dist
COPY --from=builder /repo/hls/package.json ./hls/package.json
COPY --from=builder /repo/hls/dist ./hls/dist

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "saas/dist/main"]
