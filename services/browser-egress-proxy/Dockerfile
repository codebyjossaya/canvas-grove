FROM node:20-bookworm-slim
WORKDIR /app
COPY services/browser-egress-proxy/package.json services/browser-egress-proxy/server.mjs ./
COPY services/browser-network-policy.mjs ./
USER node
EXPOSE 3128
CMD ["node", "server.mjs"]
