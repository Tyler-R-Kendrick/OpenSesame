import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function fixture(toolchain) {
  const root = mkdtempSync(join(tmpdir(), "os-fuzz-toolchain-contract-"));
  const checkout = join(root, "checkout");
  for (const dir of [
    "scripts/fuzz",
    "scripts/lib",
    "tests/fuzz/cargo/fuzz_targets",
    "bin",
  ]) {
    mkdirSync(join(checkout, dir), { recursive: true });
  }
  for (const path of [
    "scripts/fuzz/fuzz-pr-gate.sh",
    "scripts/lib/fuzz-directory.sh",
    "scripts/lib/audit-directory.sh",
  ]) {
    copyFileSync(path, join(checkout, path));
  }
  const trace = join(root, "cargo.calls");
  const cargo = join(checkout, "bin/cargo");
  writeFileSync(
    cargo,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$COMMAND_TRACE"\nif [[ "$2" == metadata && " $* " != *" --no-deps "* ]]; then exit "${CONTRACT_METADATA_EXIT:-0}"; fi\nexit "${CONTRACT_CARGO_EXIT:-0}"\n',
  );
  chmodSync(cargo, 0o700);
  spawnSync("git", ["init", "--quiet", checkout]);
  const env = {
    ...process.env,
    PATH: `${join(checkout, "bin")}:${process.env.PATH}`,
    COMMAND_TRACE: trace,
  };
  env.OPENSESAME_AUDIT_DIR = undefined;
  env.OPENSESAME_FUZZ_TOOLCHAIN = undefined;
  if (toolchain !== undefined) env.OPENSESAME_FUZZ_TOOLCHAIN = toolchain;
  return { checkout, trace, env };
}

function run(toolchain, cargoExit = "0", metadataExit = "0") {
  const f = fixture(toolchain);
  const result = spawnSync("bash", ["scripts/fuzz/fuzz-pr-gate.sh"], {
    cwd: f.checkout,
    env: {
      ...f.env,
      CONTRACT_CARGO_EXIT: cargoExit,
      CONTRACT_METADATA_EXIT: metadataExit,
    },
    encoding: "utf8",
  });
  const calls = existsSync(f.trace) ? readFileSync(f.trace, "utf8") : "";
  return { result, calls };
}

describe("canonical Rust fuzz toolchain selection command contracts", () => {
  it.each([
    [undefined, "+nightly"],
    ["nightly-2026-10-06", "+nightly-2026-10-06"],
  ])(
    "preserves real cargo command shape for %s (recording fixture, not a fuzz run)",
    (selected, expected) => {
      const { result, calls } = run(selected);
      expect(result.status).toBe(0);
      expect(calls).toContain(`${expected} fuzz --version`);
      expect(calls).toContain(`${expected} metadata --format-version 1`);
      expect(calls).toContain(`${expected} fuzz run vault_envelope`);
      expect(calls).toContain("-max_total_time=60 -timeout=10");
      expect(
        calls
          .split("\n")
          .filter(Boolean)
          .every((line) => line.startsWith(expected)),
      ).toBe(true);
    },
  );

  it.each(["stable", "nightly --config=unsafe", "../escape", "nightly-2026"])(
    "rejects unsupported or argument-like selector %s before cargo",
    (selected) => expect(run(selected).result.status).not.toBe(0),
  );

  it("refuses an unavailable selected genuine toolchain/tool", () => {
    const { result } = run("nightly-2026-10-06", "1");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cargo-fuzz is not installed");
  });

  it("refuses a stale full dependency closure before invoking the fuzz engine", () => {
    // Recording metadata returns 101 for the full closure; --no-deps misses it.
    const { result, calls } = run("nightly-2026-10-06", "0", "101");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cargo.lock is stale");
    expect(calls).toContain("metadata --format-version 1");
    expect(calls).toContain("--locked");
    expect(calls).not.toContain("--no-deps");
    expect(calls).not.toContain("fuzz run");
  });
});
