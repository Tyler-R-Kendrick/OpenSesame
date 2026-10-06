import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSameInputs } from "./test-depth-inputs.mjs";
import { canonicalFamilies, testDepthPlan } from "./test-depth-plan.mjs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const depth = readFileSync(
  ".github/workflows/test-depth-admission.yml",
  "utf8",
);
const runner = readFileSync("scripts/test/test-depth-run.sh", "utf8");

function collect(requested, result, heavy = "success", changes = "success") {
  const shell = ci
    .split("  typescript:\n")[1]
    .split("  bundle-check:\n")[0]
    .split("        run: |\n")[1]
    .replace(/^ {10}/gm, "")
    .replaceAll("${{ needs.changes.result }}", changes)
    .replaceAll("${{ needs.typescript-tests.result }}", heavy)
    .replaceAll(
      "${{ github.event_name == 'workflow_dispatch' && inputs.test_depth }}",
      requested,
    )
    .replaceAll("${{ needs.test-depth.result }}", result);
  return spawnSync("bash", ["-c", shell], { stdio: "ignore" }).status;
}

describe("requested hosted test depth fails closed", () => {
  it("plans all eight canonical families and distinct feature scopes", () => {
    expect(canonicalFamilies).toEqual([
      "verify",
      "coverage-ts",
      "coverage-rust",
      "scans",
      "mutation-ts",
      "mutation-rust",
      "fuzz-ts",
      "fuzz-rust",
    ]);
    expect(testDepthPlan("false").family).toEqual([
      ...canonicalFamilies,
      "feature-mutation",
      "feature-fuzz",
    ]);
    expect(testDepthPlan("true").family).toContain("feature-extension");
    expect(new Set(testDepthPlan("true").family).size).toBe(11);
    expect(() => testDepthPlan("undefined")).toThrow();
  });

  it.each(["failure", "skipped", "cancelled", "", "timed_out"])(
    "refuses a requested %s family result in the required aggregate",
    (result) => expect(collect("true", result)).not.toBe(0),
  );

  it("preserves unrequested CI and requires successful detection and TS", () => {
    expect(collect("true", "success")).toBe(0);
    expect(collect("false", "skipped")).toBe(0);
    expect(collect("false", "success")).not.toBe(0);
    expect(collect("true", "success", "failure")).not.toBe(0);
    expect(collect("true", "success", "success", "failure")).not.toBe(0);
  });

  it("calls the branch-local reusable workflow only on explicit manual request", () => {
    expect(ci).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.test_depth",
    );
    expect(ci).toContain("uses: ./.github/workflows/test-depth-admission.yml");
    expect(ci).toContain("needs: [changes, typescript-tests, test-depth]");
    expect(depth).toContain("  workflow_call:");
    expect(depth).toContain("fail-fast: false");
    expect(depth).not.toContain("continue-on-error");
    expect(depth).not.toContain("TS_COVERAGE_LINES:");
  });

  it("requires successful planning and the complete matrix", () => {
    for (const plan of ["success", "failure", "skipped", ""]) {
      for (const result of ["success", "failure", "skipped", "cancelled", ""]) {
        const status = spawnSync(
          "bash",
          ["-c", 'test "$PLAN:$DEPTH" = success:success'],
          {
            env: { ...process.env, PLAN: plan, DEPTH: result },
          },
        ).status;
        expect(status === 0).toBe(plan === "success" && result === "success");
      }
    }
    expect(depth).toContain('run: test "$PLAN:$DEPTH" = success:success');
  });

  it("runs canonical gates and retains raw failures without fake fallbacks", () => {
    for (const command of [
      "pnpm verify",
      "pnpm test:coverage:ts",
      "pnpm test:coverage:rust",
      "pnpm test:mutation:ts",
      "pnpm test:mutation:rust",
      "pnpm test:fuzz",
      "pnpm audit:fuzz",
    ]) {
      expect(runner).toContain(command);
    }
    expect(runner).toContain(
      "cve-lite osv ast-grep gitleaks semgrep cargo-audit",
    );
    expect(runner).toContain('statuses=("${PIPESTATUS[@]}")');
    expect(depth).toContain("JAZZER_ALLOW_FALLBACK: 0");
    expect(depth).toContain("if: always()");
    expect(depth).toContain("if-no-files-found: error");
    expect(depth).not.toContain("35 GiB");
  });

  it("rejects changed, removed, or added tracked inputs", () => {
    const before = [{ path: "Cargo.lock", sha256: "original" }];
    expect(() => assertSameInputs(before, before)).not.toThrow();
    expect(() => assertSameInputs(before, [])).toThrow();
    expect(() =>
      assertSameInputs(before, [...before, { path: "new", sha256: "added" }]),
    ).toThrow();
    expect(() =>
      assertSameInputs(before, [{ path: "Cargo.lock", sha256: "modified" }]),
    ).toThrow();
  });
});
