import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // `next dev` on jc-homelab is reached through the tailnet hostname.
  allowedDevOrigins: ["canvas-grove.tail8dc4e4.ts.net"],
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    cpus: 1,
    memoryBasedWorkersCount: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
      },
    },
  },
};

export default nextConfig;
