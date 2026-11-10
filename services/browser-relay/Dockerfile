FROM node:20-bookworm-slim
WORKDIR /app
COPY services/browser-relay/package.json services/browser-relay/server.mjs ./
COPY services/browser-network-policy.mjs ./
USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
