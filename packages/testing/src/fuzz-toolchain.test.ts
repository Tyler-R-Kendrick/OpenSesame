import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Rust fuzz tooling", () => {
  it.each([
    "scripts/fuzz/fuzz-batch.sh",
    "tests/fuzz/clusterfuzzlite/build.sh",
  ])("pins nightly in %s", (path) => {
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain("cargo +nightly fuzz");
    expect(source).not.toMatch(/cargo fuzz (?:run|build|--version)/u);
  });

  it("keeps default nightly and validates explicit nightly dates in the PR gate", () => {
    const source = readFileSync(
      join(root, "scripts/fuzz/fuzz-pr-gate.sh"),
      "utf8",
    );
    expect(source).toContain(
      'FUZZ_TOOLCHAIN="${OPENSESAME_FUZZ_TOOLCHAIN:-nightly}"',
    );
    expect(source).toContain(
      '[[ "$FUZZ_TOOLCHAIN" =~ ^nightly(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$ ]] ||',
    );
    expect(source).toContain('cargo "+$FUZZ_TOOLCHAIN" fuzz --version');
    expect(source).toContain(
      'cargo "+$FUZZ_TOOLCHAIN" metadata --format-version 1',
    );
    expect(source).toContain(
      'cargo "+$FUZZ_TOOLCHAIN" fuzz run "$target" --fuzz-dir tests/fuzz/cargo "$corpus" --',
    );
    expect(source).toContain("-timeout=10");
    expect(source).not.toMatch(/cargo fuzz (?:run|build|--version)/u);
  });

  it.each(["scripts/fuzz/fuzz-pr-gate.sh", "scripts/fuzz/fuzz-batch.sh"])(
    "requires a current fuzz lockfile in %s",
    (path) => {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain(
        "--manifest-path tests/fuzz/cargo/Cargo.toml --locked",
      );
    },
  );
});
