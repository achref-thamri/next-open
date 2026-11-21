# syntax=docker/dockerfile:1

# Pinned to a digest so a rebuild gets the same image; Dependabot moves the digest weekly.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production \
    DATABASE_PATH=/data/next-open.db \
    HEARTBEAT_PATH=/data/heartbeat \
    TZ=UTC
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
