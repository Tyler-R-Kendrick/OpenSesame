import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Rust fuzz tooling", () => {
  it.each([
    "scripts/fuzz-pr-gate.sh",
    "scripts/fuzz-batch.sh",
    "infra/clusterfuzzlite/build.sh",
  ])("pins nightly in %s", (path) => {
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain("cargo +nightly fuzz");
    expect(source).not.toMatch(/cargo fuzz (?:run|build|--version)/u);
  });

  it.each(["scripts/fuzz-pr-gate.sh", "scripts/fuzz-batch.sh"])(
    "requires a current fuzz lockfile in %s",
    (path) => {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain("--manifest-path fuzz/Cargo.toml --locked");
    },
  );
});
