import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["yahoo-finance2", "@electric-sql/pglite"],
};

export default nextConfig;
