FROM docker:27-cli AS dockercli
# Node 22: the DOM-mirror engine uses the built-in WebSocket client for CDP.
FROM node:22-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends novnc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs orphan-policy.mjs navigation-policy.mjs display-policy.mjs ./
COPY viewer/viewer.html viewer/viewer.js viewer/viewer.css viewer/viewer-input.js ./viewer/
COPY viewer/mirror-client.js viewer/mirror-dom.js viewer/mirror-protocol.js ./viewer/
COPY mirror/engine.mjs mirror/capture.js ./mirror/
RUN mkdir -p /var/lib/canvas-grove/state && chown -R node:node /var/lib/canvas-grove
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
