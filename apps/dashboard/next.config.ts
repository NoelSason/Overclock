import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@overclock/contracts"],
  // The workspace root holds the shared contracts package; Turbopack must be able to resolve it.
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
