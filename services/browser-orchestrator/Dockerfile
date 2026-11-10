FROM docker:27-cli AS dockercli
FROM node:20-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends novnc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs orphan-policy.mjs navigation-policy.mjs display-policy.mjs ./
COPY viewer/viewer.html viewer/viewer.js viewer/viewer.css viewer/viewer-input.js ./viewer/
RUN mkdir -p /var/lib/canvas-grove/state && chown -R node:node /var/lib/canvas-grove
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
