import path from "node:path";
import type { NextConfig } from "next";

const api = process.env["NEXT_PUBLIC_API_URL"] ?? "";
const rpc = process.env["NEXT_PUBLIC_RPC_URL"] ?? "";
const faucet = process.env["NEXT_PUBLIC_DEV_FAUCET_URL"] ?? "";

// The private link's secret lives in the URL fragment: never leak URLs via Referer, never load third-party scripts.
const csp = [
  "default-src 'self'",
  `connect-src 'self' ${api} ${rpc} ${faucet}`.trim(),
  "img-src 'self' data: https://cdn.robinhood.com",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  // NEXT_OUTPUT=standalone: a self-contained server (node server.js) for small VPS deploys (deploy/lite).
  ...(process.env["NEXT_OUTPUT"] === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: path.resolve(process.cwd(), "../..") }
    : {}),
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next",
  transpilePackages: ["@sealdesk/sdk", "@sealdesk/crypto", "@sealdesk/shared"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
