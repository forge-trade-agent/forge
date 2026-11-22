// Bundles the SDK into one browser-safe ES module (served by the API at /sdk/forge.mjs).
// platform=browser makes the build FAIL if any Node-only module sneaks into the SDK graph.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const out = "dist/forge.mjs";
const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: out,
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
const bytes = readFileSync(out);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${out}.sha256`, `${sha256}  forge.mjs\n`);
const inputs = Object.keys(result.metafile.inputs).filter((f) => /node:|pino|ioredis|pg\//.test(f));
if (inputs.length) {
  console.error("server-only modules leaked into the SDK bundle:", inputs);
  process.exit(1);
}
console.log(`${out}: ${(bytes.length / 1024).toFixed(1)} KiB, sha256 ${sha256}`);
