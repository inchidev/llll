FROM docker:28.4.0-cli AS docker
FROM node:26.11.1-bookworm-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/runner
COPY src ./src
EXPOSE 8081
CMD ["node", "src/server.mjs"]
