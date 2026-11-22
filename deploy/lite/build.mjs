// Builds the "lite" release for a small VPS (no Docker, no Postgres, no Redis):
//   deploy/lite/dist/api/   server.mjs (API + jobs, one file) + PGlite assets + migrations
//   deploy/lite/dist/web/   Next.js standalone server (node apps/web/server.js)
// Usage: node deploy/lite/build.mjs   (reads deploy/lite/site.env for the NEXT_PUBLIC_* values)
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "deploy/lite/dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "api"), { recursive: true });

// ---- API: one ESM file. PGlite loads its wasm/data next to the bundle.
await build({
  entryPoints: [path.join(root, "apps/api/src/lite.ts")],
  outfile: path.join(dist, "api/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // CJS dependencies inside an ESM bundle need require/__dirname.
  banner: {
    js: [
      'import { createRequire as __cr } from "node:module";',
      'import { fileURLToPath as __fu } from "node:url";',
      'import { dirname as __dn } from "node:path";',
      "const require = __cr(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
});
const pglite = path.join(root, "node_modules/@electric-sql/pglite/dist");
for (const f of ["pglite.wasm", "pglite.data", "initdb.wasm"]) {
  if (existsSync(path.join(pglite, f))) cpSync(path.join(pglite, f), path.join(dist, "api", f));
}
cpSync(path.join(root, "packages/db/migrations"), path.join(dist, "api/migrations"), { recursive: true });
for (const [from, to] of [["packages/sdk/dist/forge.mjs", "forge.mjs"], ["packages/mcp/dist/forge-mcp.mjs", "forge-mcp.mjs"]]) {
  if (existsSync(path.join(root, from))) cpSync(path.join(root, from), path.join(dist, "api", to));
}
console.log("api  → deploy/lite/dist/api");

// ---- Web: Next standalone with the public values baked in.
const siteEnv = Object.fromEntries(
  readFileSync(path.join(root, "deploy/lite/site.env"), "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const webDir = path.join(root, "apps/web");
// next build also reads apps/web/.env(.local), which the local dev stack writes (dev wallet, faucet on
// 127.0.0.1). Blank every NEXT_PUBLIC_* there that site.env doesn't set, so none of it ships.
// (Next never overrides a variable that is already set, even to "".)
for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  const p = path.join(webDir, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const k = line.match(/^(NEXT_PUBLIC_[A-Z0-9_]+)=/)?.[1];
    if (k && !(k in siteEnv)) siteEnv[k] = "";
  }
}
for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_") && !(k in siteEnv)) siteEnv[k] = "";
const distDir = ".next-lite";
execSync("npx next build", {
  cwd: webDir, stdio: "inherit",
  env: { ...process.env, ...siteEnv, NEXT_OUTPUT: "standalone", NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" },
});
const sa = path.join(webDir, distDir, "standalone");
cpSync(sa, path.join(dist, "web"), { recursive: true });
// The standalone server serves static files from <app>/<distDir>/static.
cpSync(path.join(webDir, distDir, "static"), path.join(dist, "web/apps/web", distDir, "static"), { recursive: true });
// ...and public files (logos under /brand/) from <app>/public.
if (existsSync(path.join(webDir, "public"))) cpSync(path.join(webDir, "public"), path.join(dist, "web/apps/web/public"), { recursive: true });
rmSync(path.join(webDir, distDir), { recursive: true, force: true });
console.log("web  → deploy/lite/dist/web (start: node apps/web/server.js)");
