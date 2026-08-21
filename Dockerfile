# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-slim AS build

ENV CI=true

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        g++ \
        make \
        node-gyp \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .
RUN bun run build:node

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    GMPAY_DATA_DIR=/var/lib/gmpay

WORKDIR /app

RUN groupadd --system --gid 10001 gmpay \
    && useradd --system --uid 10001 --gid gmpay --home-dir /nonexistent gmpay \
    && mkdir --parents /var/lib/gmpay \
    && chown gmpay:gmpay /var/lib/gmpay

COPY --from=build --chown=gmpay:gmpay /app/.output ./.output
COPY --from=build --chown=gmpay:gmpay /app/drizzle ./drizzle
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build --chown=gmpay:gmpay /app/package.json /app/tsconfig.json ./
COPY --from=build --chown=gmpay:gmpay /app/scripts/data.ts ./scripts/data.ts
COPY --from=build --chown=gmpay:gmpay /app/src/server/runtime/types.ts ./src/server/runtime/types.ts
COPY --from=build --chown=gmpay:gmpay /app/src/server/runtime/node/data-layout.ts /app/src/server/runtime/node/migrations.ts /app/src/server/runtime/node/object-storage.ts ./src/server/runtime/node/

USER gmpay

EXPOSE 3000
VOLUME ["/var/lib/gmpay"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", ".output/server/index.mjs"]
