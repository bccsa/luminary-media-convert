# syntax=docker/dockerfile:1.7
# Build context: repo root. Build: `docker build -f api/Dockerfile . -t lmc-api`

FROM node:22-bookworm-slim

# ffmpeg/ffprobe: media processing at runtime
# curl + python3: required by tusd/scripts/download-tusd.sh (GitHub Releases + JSON parse)
# tini: clean PID 1 signal handling so docker stop terminates the Node process cleanly
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        python3 \
        ca-certificates \
        tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in the full workspace tree (filtered by .dockerignore). npm workspaces
# requires every workspace listed in the root package.json to exist on disk,
# so we copy all of them even though only api/hls/tusd are built here.
COPY . .

RUN npm ci \
 && npm -w hls run build \
 && npm -w tusd run build \
 && npm -w tusd run download-tusd \
 && npm -w api run build \
 && npm prune --omit=dev \
 && npm cache clean --force

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "api/dist/main"]
