// Regenerates capabilities.json from the TypeScript source of truth.
// Run `pnpm --filter @opensesame/capability-registry generate` after editing
// CAPABILITIES; the sync test fails until the committed JSON matches.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, surfaceGaps } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "capabilities.json");
writeFileSync(target, `${JSON.stringify(CAPABILITIES, null, 2)}\n`);
console.log(`wrote ${target} (${CAPABILITIES.length} capabilities)`);
// The known gaps: every surface of every capability that is neither mapped
// nor excluded (ADR 0139). The registry test fails until this matches.
const gapsTarget = join(here, "..", "surface-gaps.json");
writeFileSync(gapsTarget, `${JSON.stringify(surfaceGaps(), null, 2)}\n`);
console.log(`wrote ${gapsTarget}`);
