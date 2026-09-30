# Fritter Board: a small server-rendered app, run directly with tsx (as the
# Fritter Post runs its scripts). No build step.
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
# tsx is needed at runtime, so dev dependencies stay installed.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY config ./config
# Personas are starting points (the database holds the live ones); the
# voice probe reads them from here.
COPY personas ./personas
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

RUN addgroup --system --gid 1001 board && adduser --system --uid 1001 --ingroup board board
USER board

# 3100 is the web app; 3101 the MCP server (the compose file's `mcp` service).
EXPOSE 3100 3101
ENV PORT=3100
CMD ["npx", "tsx", "src/server.ts"]
