FROM docker:29.9.1-cli AS docker
FROM node:26.12.0-bookworm-slim
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/runner
COPY --chmod=0644 src ./src
EXPOSE 8081
CMD ["node", "src/server.mjs"]
