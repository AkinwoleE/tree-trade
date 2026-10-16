import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [{ source: "/leaves", destination: "/seeds", permanent: true }];
  },
};

export default nextConfig;
