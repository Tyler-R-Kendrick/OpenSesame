import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MARKER = "OPENSESAME_CLI_APP_INTEGRATION_SEAM";
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function isExcluded(relativePath: string): boolean {
  if (relativePath.endsWith(".test.ts")) return true;
  if (relativePath.includes("/fixtures/")) return true;
  if (relativePath.endsWith("seams_test_only.rs")) return true;
  return false;
}

async function scanDir(
  absoluteDir: string,
  violations: string[],
): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(absolutePath, violations);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".rs")) continue;
    const rel = relative(repoRoot, absolutePath);
    if (isExcluded(rel)) continue;
    const text = await readFile(absolutePath, "utf8");
    if (text.includes(MARKER)) violations.push(rel);
  }
}

describe("cli app integration seam guard", () => {
  it("keeps the seam env name out of production sources", async () => {
    const violations: string[] = [];
    await scanDir(join(repoRoot, "packages/cli/src"), violations);
    for (const crate of await readdir(join(repoRoot, "crates"))) {
      const src = join(repoRoot, "crates", crate, "src");
      try {
        await scanDir(src, violations);
      } catch {
        // crate without src/
      }
    }
    await scanDir(join(repoRoot, "apps/cli/src"), violations);
    expect(violations).toEqual([]);
  });
});
