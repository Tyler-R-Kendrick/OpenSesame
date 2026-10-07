import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";
import { isNativeInput, nativeCrateDirs } from "./ci-native-area.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const native = readFileSync(
  join(root, ".github/workflows/native-admission.yml"),
  "utf8",
);
const collector = ci.split("  rust-check:")[1];
const shell = collector.split("        run: |\n")[1].replace(/^ {10}/gm, "");

function collect(
  required,
  nativeResult,
  rust = "success",
  changes = "success",
) {
  const script = shell
    .replaceAll("${{ needs.changes.result }}", changes)
    .replaceAll("${{ needs.rust.result }}", rust)
    .replaceAll("${{ needs.changes.outputs.native }}", required)
    .replaceAll("${{ needs.native.result }}", nativeResult)
    .replaceAll("${{ needs.changes.outputs.native_mobile }}", "false")
    .replaceAll("${{ needs.android-native.result }}", "skipped")
    .replaceAll("${{ needs.apple-native.result }}", "skipped");
  return spawnSync("bash", ["-c", script], { stdio: "ignore" }).status;
}

const nativeInputs = [
  "apps/android/ios/Sources/OpenSesameAuthenticator/NativeRealmState.swift",
  "apps/android/android/app/src/androidTest/RealmTest.kt",
  "apps/android/scripts/test-apple.sh",
  "apps/android/scripts/test-windows.ps1",
  "apps/cli/src/main.rs",
  "crates/gateway/src/lib.rs",
  "crates/connector-host/src/lib.rs",
  "crates/new-windows-dependency/src/lib.rs",
  "Cargo.future",
  "crates/authenticator-core/src/lib.rs",
  "crates/human-vault/src/lib.rs",
  "crates/domain/src/lib.rs",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo/config.toml",
  ".github/workflows/native-admission.yml",
  ".github/workflows/ci.yml",
  "packages/app-core/src/lib/retired-credentials/protocol-vectors.json",
  "packages/app-core/src/lib/credential-canaries/protocol-vectors.json",
  "packages/app-core/src/lib/credential-observation/protocol-vectors.json",
];

function verifyWindowsCases() {
  const script = readFileSync(
    join(root, "apps/android/scripts/test-windows.ps1"),
    "utf8",
  );
  const catalog = JSON.parse(
    readFileSync(
      join(root, "apps/android/scripts/native-required-cases.json"),
      "utf8",
    ),
  );
  for (const [label, count] of [
    ["canaries", 14],
    ["authenticator", 13],
    ["windows-positive-traps", 7],
    ["windows-positive-canaries", 10],
    ["native-cli-trap-lifecycle", 3],
    ["native-cli-real-conpty", 3],
  ]) {
    expect(script).toContain(`Invoke-NativeTests "${label}"`);
    expect(catalog.rust[label]).toHaveLength(count);
    expect(new Set(catalog.rust[label]).size).toBe(count);
  }
  expect(catalog.rust["windows-positive-traps"]).toContain(
    "windows_supported_store_without_traps_preserves_fresh_owner_and_rejects_unknown_passwords",
  );
  expect(catalog.rust["windows-positive-traps"]).toContain(
    "safely_published_same_context_snapshot_retains_classification_without_real_authority",
  );
  expect(script).toContain("verify-native-results.py");
  expect(script).not.toContain("MinimumPassed");
  expect(script).not.toContain("continue-on-error");
  expect(script).not.toContain("--ignored");
}

describe("native platform admission participates in required CI", () => {
  it("follows native Rust transitive inputs, including the full Windows CLI and human-vault test dependencies", () => {
    expect(nativeCrateDirs()).toEqual(
      expect.arrayContaining([
        "crates/authenticator-core",
        "crates/human-vault",
        "crates/sealed-store",
        "crates/domain",
        "apps/cli",
        "crates/gateway",
        "crates/daemon",
        "crates/storage",
      ]),
    );
    expect(() => nativeCrateDirs([])).toThrow("Native input graph has no");
    expect(isNativeInput("apps/pages/src/App.tsx")).toBe(false);
    expect(areasForPaths(["docs/adr/native.md"]).native).toBe(false);
    expect(areasForPaths(["apps/pages/src/App.tsx"]).native).toBe(false);
    expect(areasForPaths(["unrecognized-input.bin"]).native).toBe(true);
  });

  it.each(nativeInputs)("requires native platform checks for %s", (path) => {
    expect(areasForPaths([path]).native).toBe(true);
  });

  it("invokes the reusable native workflow only for affected inputs", () => {
    const job = ci.split("  native:\n")[1]?.split("  rust-check:\n")[0];
    expect(job).toContain("needs: changes");
    expect(job).toContain("if: needs.changes.outputs.native == 'true'");
    expect(job).toContain("uses: ./.github/workflows/native-admission.yml");
    expect(job).not.toContain("continue-on-error");
    expect(native).toContain("  workflow_call:");
    expect(native).toContain("  workflow_dispatch:");
    expect(native).not.toContain("  pull_request:");
    for (const jobName of [
      "windows",
      "android",
      "android-device",
      "apple-sdk",
      "swift",
    ]) {
      const header = native
        .split(`  ${jobName}:\n`)[1]
        ?.split("    steps:\n")[0];
      expect(header, jobName).toBeDefined();
      expect(header, jobName).not.toMatch(/^ {4}if:/m);
      expect(header, jobName).not.toContain("continue-on-error");
    }
    expect(native).toContain("pages: 4096");
    expect(native).toContain("pages: 16384");
    expect(collector).toContain(
      "needs: [changes, rust, native, android-native, apple-native]",
    );
  });

  it("requires unconditional Windows engine, FFI and CLI phases and rejects optional failure handling", () => {
    const windows = native.split("  windows:\n")[1]?.split("\n  android:\n")[0];
    expect(windows).toBeDefined();
    expect(windows).toContain("runs-on: windows-2022");
    expect(windows).not.toContain("continue-on-error");
    const phases = windows.split("    steps:\n")[1].split(/\n {6}- /);
    for (const phase of ["engine", "ffi", "cli"]) {
      const running = phases.filter((text) =>
        text.includes(
          `run: ./apps/android/scripts/test-windows.ps1 -Phase ${phase}`,
        ),
      );
      expect(running, phase).toHaveLength(1);
      expect(running[0], phase).not.toMatch(/^ {8}if:/m);
    }
    // These checks execute under the required TypeScript job's quality gate.
    expect(ci).toContain("run: pnpm quality");
    const scripts = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).scripts;
    expect(scripts.quality).toContain("pnpm quality:test");
    expect(scripts["quality:test"]).toContain("vitest run scripts/lib");
  });

  it(
    "requires exact executed Windows positive storage and terminal cases after activation",
    verifyWindowsCases,
  );

  it("executes the required Rust collector and rejects skipped or failed affected native jobs", () => {
    expect(collect("true", "success")).toBe(0);
    expect(collect("false", "skipped", "skipped")).toBe(0);
    for (const result of ["skipped", "failure", "cancelled", "", "unknown"])
      expect(collect("true", result), result).toBe(1);
    expect(collect("false", "failure")).toBe(1);
    expect(collect("", "skipped")).toBe(1);
    expect(collect("true", "success", "failure")).toBe(1);
    expect(collect("true", "success", "success", "failure")).toBe(1);
  });
});
