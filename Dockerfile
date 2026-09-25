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
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

RUN addgroup --system --gid 1001 board && adduser --system --uid 1001 --ingroup board board
USER board

EXPOSE 3100
ENV PORT=3100
CMD ["npx", "tsx", "src/server.ts"]
