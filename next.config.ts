import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow longer API route execution for Puppeteer operations
  serverExternalPackages: ["puppeteer"],
};

export default nextConfig;
