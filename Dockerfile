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
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install -g bun && bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist

EXPOSE 5100

CMD ["node", "dist/index.js"]
