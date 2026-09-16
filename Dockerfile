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

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install -g bun && bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist

EXPOSE 5100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5100/health || exit 1

CMD ["node", "dist/index.js"]
