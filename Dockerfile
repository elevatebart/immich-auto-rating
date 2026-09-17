# Build on the full image, run on alpine as a non-root user. No native modules: node:sqlite is
# built in and pg is pure JS, so there is nothing to compile for linux/amd64.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production STATE_DIR=/data/state CONFIG=/data/config.toml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["report"]
