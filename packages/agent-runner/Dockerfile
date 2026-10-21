FROM docker:28.4.0-cli AS docker
FROM node:24.21.0-bookworm-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/runner
COPY src ./src
EXPOSE 8081
CMD ["node", "src/server.mjs"]
