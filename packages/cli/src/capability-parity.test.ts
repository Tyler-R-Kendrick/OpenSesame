import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

// Agent-surface parity pact (ADR 0065): every `surfaces.cli` command the
// registry claims for the `opensesame-id` binary must still exist in the
// argument grammar. Renaming a verb without a registry update fails here.
const grammar = [
  readFileSync(join(here, "parse.ts"), "utf8"),
  readFileSync(join(here, "run.ts"), "utf8"),
]
  .join("\n")
  .toLowerCase();

function hasWord(token: string): boolean {
  const pattern = new RegExp(
    `(^|[^a-z0-9])${token.toLowerCase()}([^a-z0-9]|$)`,
  );
  return pattern.test(grammar);
}

describe("capability registry ↔ opensesame-id parity", () => {
  it("every registered identity CLI surface exists in the grammar", () => {
    const surfaces = CAPABILITIES.map((c) => c.surfaces.cli).filter(
      (cli): cli is string => cli?.startsWith("opensesame-id ") ?? false,
    );
    expect(surfaces.length).toBeGreaterThanOrEqual(5);
    const missing: string[] = [];
    for (const surface of surfaces) {
      for (const token of surface.split(/\s+/).slice(1)) {
        if (!hasWord(token)) {
          missing.push(`${surface} → ${token}`);
        }
      }
    }
    expect(missing, missing.join("; ")).toEqual([]);
  });
});
