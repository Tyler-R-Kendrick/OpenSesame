import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("SB-069 a vault import lands whole or not at all", () => {
  it("the import writes once", () => {
    const hook = readFileSync(join(here, "useVaultSecrets.ts"), "utf8");
    // A `for (… of imported.items) await saveItem(…)` is exactly the
    // partial-import bug this case exists to catch. The store's half — that
    // `saveItems` is one change — is in the core's sops/boundaries test.
    expect(hook).not.toMatch(/for \([^)]*imported\.items\)/u);
    expect(hook).toMatch(/await saveItems\(imported\.items\)/u);
  });
});
