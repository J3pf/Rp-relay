# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 usa binarios precompilados; las herramientas de compilación son el respaldo (arm64 sin prebuild)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
RUN npm ci
COPY tsconfig.json ./
COPY packages ./packages
COPY src ./src
COPY migrations ./migrations
RUN npm run build \
    && rm -f dist/.tsbuildinfo packages/protocol/dist/.tsbuildinfo \
    && npm prune --omit=dev \
    && npm cache clean --force

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="rp-relay" \
      org.opencontainers.image.description="Self-hosted relay connecting Pi agents with the RP Android app" \
      org.opencontainers.image.source="https://github.com/j3pf/rp-relay"
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    RP_DATA_DIR=/var/lib/rp-relay \
    RP_LISTEN_HOST=0.0.0.0 \
    RP_LISTEN_PORT=8787
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN chmod +x /app/dist/cli/index.js \
    && ln -s /app/dist/cli/index.js /usr/local/bin/rp-relay \
    && mkdir -p /var/lib/rp-relay \
    && chown -R node:node /var/lib/rp-relay
USER node
VOLUME /var/lib/rp-relay
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli/index.js"]
CMD ["serve"]

