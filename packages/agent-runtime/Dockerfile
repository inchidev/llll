FROM node:26.11.1-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
RUN pnpm install --filter @llll/agent-runtime --frozen-lockfile --ignore-scripts
COPY packages/agent-runtime/src packages/agent-runtime/src
# The modern deploy path derives a dedicated frozen lockfile. Legacy deploy
# re-resolves dependencies and can silently change the runtime between builds.
RUN pnpm --config.inject-workspace-packages=true --filter @llll/agent-runtime deploy --prod /out

FROM node:26.11.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV LLLL_AGENT_DATA=/data PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
