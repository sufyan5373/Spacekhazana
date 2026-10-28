FROM node:20-bookworm-slim

# ffmpeg + python3 + yt-dlp power the Khazana-Hole music search / video import.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
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

CMD ["node", "server.js"]
