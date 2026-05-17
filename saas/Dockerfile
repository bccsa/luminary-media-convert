# syntax=docker/dockerfile:1.7
# Build context: repo root. Build: `docker build -f saas/Dockerfile . -t lmc-saas`

FROM node:22-bookworm-slim

# tini: clean PID 1 signal handling so docker stop terminates the Node process cleanly
# ca-certificates: HTTPS to CouchDB / S3 / Auth0 JWKS
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in the full workspace tree (filtered by .dockerignore). npm workspaces
# requires every workspace listed in the root package.json to exist on disk,
# so we copy all of them even though only hls + saas are built here.
COPY . .

RUN npm ci \
 && npm -w hls run build \
 && npm -w saas run build \
 && npm prune --omit=dev \
 && npm cache clean --force

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "saas/dist/main"]
