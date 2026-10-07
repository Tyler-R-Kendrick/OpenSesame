import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
const workflow = read(".github/workflows/credential-rust-depth.yml");
const runner = read("scripts/quality/credential-rust-depth.sh");
const scope = JSON.parse(read("tools/mutation/credential-rust-depth.json"));

it("requires all seven separate credential Rust families and nested admission", () => {
  expect(
    [...workflow.matchAll(/^\s+- family: (\S+)$/gm)].map((match) => match[1]),
  ).toEqual([
    "coverage",
    "mutation-core",
    "mutation-adapters",
    "retired_records_parse",
    "canary_registry_validator",
    "observation_wire",
    "observation_outbox_fsm",
  ]);
  expect(workflow).toContain("  workflow_call:");
  expect(workflow).toContain("needs: depth");
  expect(workflow).toContain('run: test "$DEPTH" = success');
  expect(workflow).toContain("fail-fast: false");
  expect(workflow).not.toContain("continue-on-error");
  expect(read(".github/workflows/test-depth-admission.yml")).toContain(
    "uses: ./.github/workflows/credential-rust-depth.yml",
  );
});

it("uses a minimal separately locked public API fuzz crate", () => {
  const manifest = read("tests/fuzz/credentials-cargo/Cargo.toml");
  const dependencies = manifest
    .split("[dependencies]\n")[1]
    .split("[workspace]\n")[0];
  expect(
    [...dependencies.matchAll(/^([a-z0-9_-]+) = /gm)].map((match) => match[1]),
  ).toEqual([
    "base64",
    "chrono",
    "serde_json",
    "libfuzzer-sys",
    "opensesame-human-vault",
  ]);
  expect(manifest).toContain('base64 = "=0.22.1"');
  expect(manifest).toContain('version = "=0.4.13"');
  expect(manifest).toContain('[workspace]\nmembers = ["."]');
  expect(
    manifest.match(
      /^name = "(retired_records_parse|canary_registry_validator|observation_wire|observation_outbox_fsm)"$/gm,
    ),
  ).toHaveLength(4);
  expect(runner).toContain("--locked");
  expect(runner).toContain("tests/fuzz/credentials-cargo/Cargo.toml");
  expect(runner).not.toContain("--manifest-path tests/fuzz/cargo/Cargo.toml");
});

it("retains canonical floors and original deadlines while collecting real execution", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  expect(scripts["test:coverage:rust"]).toContain("--fail-under-lines 69");
  expect(scripts["test:coverage:rust"]).toContain("--fail-under-functions 67");
  expect(runner).toContain('-max_total_time="$seconds" -timeout=10');
  expect(runner).toContain("-max_len=131073");
  expect(runner).toContain("--test credential_oracle_controls");
  expect(runner).toContain(
    'rust-controls "$TEST_DEPTH_EVIDENCE/commands/controls.log"',
  );
  expect(runner).toContain(
    'mutation-list "$TEST_DEPTH_EVIDENCE/selection.txt"',
  );
  expect(runner).toContain('fuzz-run "$TEST_DEPTH_EVIDENCE/commands/fuzz.log"');
  expect(workflow).toContain("node scripts/lib/test-depth-inputs.mjs check");
  expect(workflow).toContain("if-no-files-found: error");
});

it("keeps explicit core and owner-adapter scopes separate without production widening", () => {
  expect(scope.core.files).toHaveLength(10);
  expect(scope.adapters.files).toHaveLength(12);
  expect(new Set([...scope.core.files, ...scope.adapters.files]).size).toBe(22);
  expect(scope.core.packages).toEqual(["opensesame-human-vault"]);
  expect(scope.adapters.packages).toEqual([
    "opensesame-authenticator-core",
    "opensesame-sealed-store",
  ]);
  expect(scope.adapters.files).toContain(
    "crates/sealed-store/src/credential_canaries/owner_witness.rs",
  );
  expect(scope.adapters.files).toContain(
    "crates/authenticator-core/src/native_canaries/delivery.rs",
  );
  expect(runner).not.toContain("--timeout");
});
