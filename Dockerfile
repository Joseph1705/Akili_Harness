# Application image: web interface + API server, compiled, non-root. Built by `docker compose build`.
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY plugins/credits/package.json plugins/credits/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY plugins ./plugins
RUN pnpm --filter @akili/web build \
 && pnpm --filter @akili/server build \
 && pnpm --filter @akili/server deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    AKILI_DATA_DIR=/data \
    AKILI_WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out /app/server
COPY --from=build /src/apps/web/dist /app/web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/dist/main.js"]
