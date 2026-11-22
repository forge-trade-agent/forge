// Regenerates packages/shared/src/abi.ts from the Foundry build output.
// Usage: (cd contracts && forge build) && node scripts/gen-abi.mjs
import fs from "node:fs";
const pick = (f, c) => JSON.parse(fs.readFileSync(`contracts/out/${f}/${c}.json`, "utf8")).abi;
const out = ["// GENERATED from contracts/out by scripts/gen-abi.mjs. Do not edit.", ""];
for (const [f, c, n] of [
  ["OtcEscrow.sol", "OtcEscrow", "otcEscrowAbi"],
  ["BuyBurnVault.sol", "BuyBurnVault", "buyBurnVaultAbi"],
]) out.push(`export const ${n} = ${JSON.stringify(pick(f, c), null, 2)} as const;`, "");
fs.writeFileSync("packages/shared/src/abi.ts", out.join("\n"));
console.log("wrote packages/shared/src/abi.ts");
