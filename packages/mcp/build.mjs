// Single-file, dependency-free MCP server for `npx` installs. Publish dist/ with its SHA-256.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const out = "dist/forge-mcp.mjs";
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node22"],
  outfile: out,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
// esbuild keeps the source shebang; make the file executable.
chmodSync(out, 0o755);
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(`${out}.sha256`, `${sha}  forge-mcp.mjs\n`);
console.log(`${out}: sha256 ${sha}`);
