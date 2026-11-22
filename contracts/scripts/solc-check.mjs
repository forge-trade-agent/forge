// Compiles every .sol file under src/, test/ and script/ with solc-js (no Foundry needed).
// Usage: node scripts/solc-check.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

const remap = [
  ["@openzeppelin/contracts/", "node_modules/@openzeppelin/contracts/"],
  ["forge-std/", "node_modules/forge-std/src/"],
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".sol") ? [p] : [];
  });
}

const sources = {};
for (const d of ["src", "test", "script"]) {
  if (!fs.existsSync(path.join(root, d))) continue;
  for (const f of walk(path.join(root, d))) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    sources[rel] = { content: fs.readFileSync(f, "utf8") };
  }
}

function findImports(p) {
  for (const [from, to] of remap) if (p.startsWith(from)) p = to + p.slice(from.length);
  const full = path.join(root, p);
  return fs.existsSync(full) ? { contents: fs.readFileSync(full, "utf8") } : { error: `not found: ${p}` };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors ?? []).filter((e) => e.severity === "error");
const warnings = (out.errors ?? []).filter((e) => e.severity !== "error");
for (const w of warnings) console.warn(w.formattedMessage);
for (const e of errors) console.error(e.formattedMessage);
const contracts = Object.values(out.contracts ?? {}).flatMap((c) => Object.keys(c));
console.log(`solc ${solc.version()}: ${contracts.length} contracts, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
