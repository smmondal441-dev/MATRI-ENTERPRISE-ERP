import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Force Next.js to inline these env vars at build time so they're
  // available in API route handlers (server-side). Without this, Turbopack
  // may not properly expose env vars loaded from .env/.env.local to
  // the Prisma client adapter in server components/API routes.
  env: {
    DATABASE_URL: process.env.DATABASE_URL || '',
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || '',
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || '',
  },
};

export default nextConfig;
