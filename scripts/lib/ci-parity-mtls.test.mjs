import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const parity = readFileSync(
  join(root, ".github/workflows/password-parity.yml"),
  "utf8",
);
const predicate =
  "needs.changes.outputs.typescript == 'true' || needs.changes.outputs.rust == 'true' || needs.changes.outputs.native == 'true'";

function collect(values = {}) {
  const inputs = {
    "needs.changes.result": "success",
    "needs.typescript-tests.result": "success",
    "github.event_name == 'workflow_dispatch' && inputs.test_depth": "false",
    "needs.test-depth.result": "skipped",
    "needs.changes.outputs.mtls": "false",
    "needs.mtls.result": "skipped",
    "needs.changes.outputs.typescript": "false",
    "needs.changes.outputs.rust": "false",
    "needs.changes.outputs.native": "false",
    "needs.password-parity.result": "skipped",
    ...values,
  };
  let shell = ci
    .split("  typescript:\n")[1]
    .split("  bundle-check:\n")[0]
    .split("        run: |\n")[1]
    .replace(/^ {10}/gm, "");
  for (const [expression, value] of Object.entries(inputs)) {
    shell = shell.replaceAll(`\${{ ${expression} }}`, value);
  }
  if (shell.includes("${{")) throw new Error("Unexpanded collector expression");
  return spawnSync("bash", ["-c", shell], { stdio: "ignore" }).status;
}

function requiresParity(path) {
  const areas = areasForPaths([path]);
  return areas.typescript || areas.rust || areas.native;
}

const parityInputs = [
  ".github/workflows/password-parity.yml",
  "apps/cli/src/main.rs",
  "apps/pages/src/App.tsx",
  "apps/browser-extension/entrypoints/options/main.ts",
  "crates/human-vault/src/lib.rs",
  "packages/app-core/src/lib/vault/store.ts",
  "packages/cli/src/parity.ts",
  "packages/vault-core/src/index.ts",
  "packages/capability-registry/src/index.ts",
  "packages/mcp-client/src/index.ts",
  "scripts/test/2password-parity.mjs",
  "spec/conformance/2password-vectors.json",
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "rust-toolchain.toml",
  ".github/workflows/ci.yml",
  "scripts/lib/ci-changed-areas.mjs",
  "apps/android/ios/Sources/OpenSesameAuthenticator/NativeRealmState.swift",
  "unrecognized-production-input.bin",
];

describe("mTLS and password parity wiring in required CI", () => {
  it("collects both results and calls parity once through the affected CI run", () => {
    const collector = ci
      .split("  typescript:\n")[1]
      .split("  bundle-check:\n")[0];
    expect(collector).toContain(
      "needs: [changes, typescript-tests, test-depth, mtls, password-parity]",
    );
    const job = ci
      .split("  password-parity:\n")[1]
      ?.split("\n  typescript:\n")[0];
    expect(job).toContain("needs: changes");
    expect(job).toContain(`if: ${predicate}`);
    expect(job).toContain("uses: ./.github/workflows/password-parity.yml");
    expect(job).not.toContain("continue-on-error");
    const events = parity.split("\npermissions:")[0];
    expect(events).toContain("  workflow_call:");
    expect(events).toContain("  workflow_dispatch:");
    expect(events).not.toContain("  pull_request:");
    expect(parity).toContain("run: pnpm test:2password-parity");
    expect(parity).toContain("timeout-minutes: 40");
    expect(parity).toContain("if-no-files-found: error");
  });

  it("isolates standalone and reusable concurrency from each other and the caller", () => {
    expect(parity).toContain(
      "group: password-parity-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(ci).toContain(
      "group: ci-${{ github.event_name }}-${{ github.ref }}",
    );
  });
});

describe("mTLS and password parity result admission", () => {
  it.each(["failure", "skipped", "cancelled", "", "unknown"])(
    "rejects an expected %s mTLS result in the actual required collector",
    (result) => {
      expect(
        collect({
          "needs.changes.outputs.mtls": "true",
          "needs.mtls.result": result,
        }),
      ).toBe(1);
    },
  );

  it.each(["failure", "skipped", "cancelled", "", "unknown"])(
    "rejects an expected %s parity result in the actual required collector",
    (result) => {
      expect(
        collect({
          "needs.changes.outputs.typescript": "true",
          "needs.password-parity.result": result,
        }),
      ).toBe(1);
    },
  );

  it("admits only successful expected suites or skipped unaffected suites", () => {
    expect(collect()).toBe(0);
    expect(
      collect({
        "needs.changes.outputs.mtls": "true",
        "needs.mtls.result": "success",
      }),
    ).toBe(0);
    for (const area of ["typescript", "rust", "native"]) {
      expect(
        collect({
          [`needs.changes.outputs.${area}`]: "true",
          "needs.password-parity.result": "success",
        }),
        area,
      ).toBe(0);
    }
    for (const suite of ["mtls", "password-parity"]) {
      for (const result of ["success", "failure", "cancelled", "", "unknown"]) {
        expect(
          collect({ [`needs.${suite}.result`]: result }),
          `${suite}:${result}`,
        ).toBe(1);
      }
    }
  });

  it("rejects missing or malformed scope instead of treating it as unaffected", () => {
    for (const area of ["mtls", "typescript", "rust", "native"]) {
      for (const value of ["", "unknown"]) {
        expect(
          collect({ [`needs.changes.outputs.${area}`]: value }),
          `${area}:${value}`,
        ).toBe(1);
      }
    }
    expect(collect({ "needs.changes.result": "failure" })).toBe(1);
  });
});

describe("password parity uses the conservative affected-area union", () => {
  it.each(parityInputs)("retains parity coverage for %s", (path) => {
    expect(requiresParity(path)).toBe(true);
  });

  it("skips docs-only changes and runs parity for a manual or no-base invocation", () => {
    for (const path of [
      "docs/adr/prose.md",
      "apps/pages/README.md",
      "packages/app-core/README.md",
    ]) {
      expect(requiresParity(path), path).toBe(false);
    }
    const output = execFileSync(
      "node",
      [join(root, "scripts/lib/ci-changed-areas.mjs")],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const area of ["typescript", "rust", "native", "mtls"]) {
      expect(output).toContain(`${area}=true\n`);
    }
  });
});
