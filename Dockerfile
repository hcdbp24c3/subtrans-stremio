# Stage 1: Build
FROM node:20-slim AS builder

RUN npm install -g bun

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN bun run build

# Stage 2: Runtime
FROM node:20-slim

# PEP 668: Debian Python is externally-managed — install ffsubsync into a venv
# and put it on PATH so `execSync('ffsubsync ...')` works.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/ffsubsync-venv && \
    /opt/ffsubsync-venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/ffsubsync-venv/bin/pip install --no-cache-dir ffsubsync && \
    ln -sf /opt/ffsubsync-venv/bin/ffsubsync /usr/local/bin/ffsubsync

ENV PATH="/opt/ffsubsync-venv/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install -g bun && bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist
COPY src/views/ ./dist/views/
# Python bridge for ffsubsync library (not emitted by tsc)
COPY src/lib/ffsubsync_run.py ./dist/lib/ffsubsync_run.py

EXPOSE 5100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5100/health || exit 1

CMD ["node", "dist/index.js"]
