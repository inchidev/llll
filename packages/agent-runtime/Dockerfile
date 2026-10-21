FROM node:24.21.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
RUN pnpm install --filter @llll/agent-runtime --frozen-lockfile --ignore-scripts
COPY packages/agent-runtime/src packages/agent-runtime/src
RUN pnpm --filter @llll/agent-runtime deploy --legacy --prod /out

FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV LLLL_AGENT_DATA=/data PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
