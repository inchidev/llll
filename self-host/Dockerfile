# Builds L4 and runs it on one celld node.
# The build stage is the only place Node runs. celld executes the Worker.

ARG NODE_VERSION=24.21.0
ARG CELLD_VERSION=0.6.2

FROM node:${NODE_VERSION}-bookworm-slim AS build

ENV NODE_OPTIONS=--max-old-space-size=6144 \
    CI=true \
    NUXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY . .

# `pnpm build` pins NODE_OPTIONS to 4096. Call nuxt with the stage env so this
# image build keeps the 6144 MiB heap.
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && mkdir -p /out \
    && esbuild_bin="$(find node_modules -path '*/@esbuild/*/bin/esbuild' -print | head -n 1)" \
    && test -n "$esbuild_bin" \
    && cp -L "$esbuild_bin" /out/esbuild \
    && chmod 755 /out/esbuild

FROM ghcr.io/denoland/celld:${CELLD_VERSION} AS celld

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/llll /var/lib/llll/celld

COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /out/esbuild /usr/local/bin/esbuild
COPY --from=build /src/.output /opt/llll/.output
COPY --from=build /src/drizzle/migrations /opt/llll/drizzle/migrations
COPY --from=build /src/wrangler.celld.json /opt/llll/wrangler.celld.json
COPY self-host/entrypoint.sh /usr/local/bin/llll-entrypoint
COPY self-host/healthcheck.sh /usr/local/bin/llll-healthcheck

RUN chmod 755 /usr/local/bin/llll-entrypoint /usr/local/bin/llll-healthcheck /usr/local/bin/esbuild /usr/local/bin/celld

WORKDIR /opt/llll

ENV CELLD_WATCH=/var/lib/llll/celld \
    CELLD_ESBUILD=/usr/local/bin/esbuild

EXPOSE 8080

LABEL org.opencontainers.image.title="llll" \
      org.opencontainers.image.source="https://github.com/inchidev/llll" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="L4 on celld with a RustFS fleet bucket"

HEALTHCHECK --interval=15s --timeout=5s --start-period=240s --retries=12 \
    CMD /usr/local/bin/llll-healthcheck

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/llll-entrypoint"]
