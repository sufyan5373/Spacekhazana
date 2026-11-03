FROM node:20-bookworm-slim

# ffmpeg + yt-dlp power the Khazana-Hole music search / video import.
# yt-dlp_linux is the standalone build: it bundles Python and the YouTube
# JS-challenge solver, so no python3 / pip is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

ENV NODE_ENV=production \
    SPACEKHAZANA_DATA=/var/data/data \
    SPACEKHAZANA_STORAGE=/var/data/uploads \
    SPACEKHAZANA_ALLOW_ANY_STORAGE=true

# Render sets PORT at runtime (default 10000); server.js reads it.
EXPOSE 10000

# Docker caches the yt-dlp download above, so it goes stale. YouTube breaks old
# versions often, so update it on every start (ignored if offline).
CMD ["sh", "-c", "yt-dlp -U || true; exec node server.js"]
