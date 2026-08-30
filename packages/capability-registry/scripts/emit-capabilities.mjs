// Regenerates capabilities.json from the TypeScript source of truth.
// Run `pnpm --filter @opensesame/capability-registry generate` after editing
// CAPABILITIES; the sync test fails until the committed JSON matches.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "capabilities.json");
writeFileSync(target, `${JSON.stringify(CAPABILITIES, null, 2)}\n`);
console.log(`wrote ${target} (${CAPABILITIES.length} capabilities)`);
