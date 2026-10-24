import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@overclock/contracts"],
  // The workspace root holds the shared contracts package; Turbopack must be able to resolve it.
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  devIndicators: false,
  // Do not write AGENTS.md into the app directory on `next dev`.
  agentRules: false,
  poweredByHeader: false,
  // Allow loading the dev server through 127.0.0.1 as well as localhost (HMR, dev assets).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
