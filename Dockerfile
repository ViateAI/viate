FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/plugin-manager/package.json packages/plugin-manager/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/sdk ./packages/sdk
COPY packages/plugin-manager ./packages/plugin-manager
COPY packages/cli ./packages/cli
RUN pnpm --filter @viateai/sdk build
RUN pnpm --filter @viateai/plugin-manager build
RUN pnpm --filter @viateai/cli build
RUN pnpm --filter @viateai/web build
RUN pnpm --filter @viateai/server build
# The workspace lockfile was already checked online by pnpm install.
# deploy writes a smaller lockfile and would refetch full metadata that
# the offline store does not keep.
RUN pnpm --filter @viateai/server deploy --prod --offline --trust-lockfile /out
RUN cp -a apps/server/dist /out/dist
RUN mkdir -p /out/web && cp -a apps/web/dist/. /out/web/
RUN mkdir -p /out/cli && cp -a packages/cli/package.json /out/cli/package.json && cp -a packages/cli/dist /out/cli/dist

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4317
ENV VIATE_DATA_DIR=/data
ENV VIATE_ADMIN_UI_DIST=/app/web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@12.16.1 --activate \
  && mkdir -p /data
COPY --from=build /out /app
RUN chmod +x /app/cli/dist/main.js \
  && ln -sf /app/cli/dist/main.js /usr/local/bin/viate \
  && chown -R node:node /app /data
USER node
EXPOSE 4317
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4317') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
