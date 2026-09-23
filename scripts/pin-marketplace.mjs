#!/usr/bin/env node
/**
 * Re-pin `.opensesame/marketplace.json` (ADR 0134): every listed definition's
 * SHA-256 over its bytes as committed. Run after editing a definition in
 * `marketplace/item-types/`; the default-marketplace test fails until you do.
 *
 *   node scripts/pin-marketplace.mjs          # rewrite the pins
 *   node scripts/pin-marketplace.mjs --check  # exit 1 if any pin is stale
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, ".opensesame", "marketplace.json");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
let stale = 0;
for (const entry of index.spec.itemTypes) {
  const digest = createHash("sha256")
    .update(readFileSync(join(root, entry.path)))
    .digest("hex");
  if (entry.sha256 !== digest) {
    stale += 1;
    console.log(`${entry.path}: ${entry.sha256 ?? "unpinned"} → ${digest}`);
    entry.sha256 = digest;
  }
}
if (process.argv.includes("--check")) process.exit(stale === 0 ? 0 : 1);
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(stale === 0 ? "pins current" : `${stale} pin(s) rewritten`);
