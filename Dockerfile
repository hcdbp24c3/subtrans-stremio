FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install -g bun && bun install --frozen-lockfile

COPY src/ ./src/
COPY tsconfig.json ./

RUN bun run build

EXPOSE 5100

CMD ["node", "dist/index.js"]
