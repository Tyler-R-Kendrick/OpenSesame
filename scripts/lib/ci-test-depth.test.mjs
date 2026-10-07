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
    .replaceAll("${{ needs.test-depth.result }}", result)
    .replaceAll("${{ needs.changes.outputs.mtls }}", "false")
    .replaceAll("${{ needs.mtls.result }}", "skipped")
    .replaceAll("${{ needs.changes.outputs.typescript }}", "false")
    .replaceAll("${{ needs.changes.outputs.rust }}", "false")
    .replaceAll("${{ needs.changes.outputs.native }}", "false")
    .replaceAll("${{ needs.password-parity.result }}", "skipped");
  if (shell.includes("${{")) throw new Error("Unexpanded collector expression");
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
    expect(testDepthPlan("false").include.map((row) => row.family)).toEqual([
      ...canonicalFamilies.flatMap((family) =>
        family === "mutation-rust" ? Array(8).fill(family) : [family],
      ),
      "feature-mutation",
      "feature-fuzz",
    ]);
    expect(testDepthPlan("true").include.map((row) => row.family)).toContain(
      "feature-extension",
    );
    expect(
      new Set(testDepthPlan("true").include.map((row) => row.family)).size,
    ).toBe(11);
    expect(testDepthPlan("true").include).toHaveLength(18);
    expect(testDepthPlan("false").include).toHaveLength(17);
    expect(
      testDepthPlan("true")
        .include.filter((row) => row.family === "mutation-rust")
        .map((row) => row.shard),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
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
    expect(ci).toContain(
      "needs: [changes, typescript-tests, test-depth, mtls, password-parity]",
    );
    expect(depth).toContain("  workflow_call:");
    expect(depth).toContain("fail-fast: false");
    expect(depth).not.toContain("continue-on-error");
    expect(depth).not.toContain("TS_COVERAGE_LINES:");
  });
});

describe("nested test-depth admission and execution evidence", () => {
  it("requires successful planning and the complete matrix", () => {
    expect(depth).toContain(
      "needs: [plan, depth, credential-rust, rust-shards]",
    );
    expect(depth).toContain(
      "uses: ./.github/workflows/credential-rust-depth.yml",
    );
    expect(depth).toContain(
      'run: test "$PLAN:$DEPTH:$CREDENTIAL_RUST:$RUST_SHARDS" = success:success:success:success',
    );
  });

  it.each(["PLAN", "DEPTH", "CREDENTIAL_RUST", "RUST_SHARDS"])(
    "rejects every unsuccessful %s nested result",
    (family) => {
      for (const result of [
        "success",
        "failure",
        "skipped",
        "cancelled",
        "",
        "timed_out",
      ]) {
        const env = {
          ...process.env,
          PLAN: "success",
          DEPTH: "success",
          CREDENTIAL_RUST: "success",
          RUST_SHARDS: "success",
          [family]: result,
        };
        const status = spawnSync(
          "bash",
          [
            "-c",
            'test "$PLAN:$DEPTH:$CREDENTIAL_RUST:$RUST_SHARDS" = success:success:success:success',
          ],
          { env },
        ).status;
        expect(status === 0).toBe(result === "success");
      }
    },
  );

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

describe("canonical native shard artifact layout", () => {
  it("uploads exactly one root for native shards and preserves other family roots", () => {
    const uploads = [
      ...depth.matchAll(
        / {6}- name: Preserve (raw execution and instrumented reports|native Rust shard single-root evidence)\n([\s\S]*?)(?=\n {6}- name:|\n {2}rust-shards:)/g,
      ),
    ];
    expect(uploads).toHaveLength(2);
    const general = uploads.find((block) =>
      block[1].startsWith("raw execution"),
    )[2];
    const native = uploads.find((block) =>
      block[1].startsWith("native Rust"),
    )[2];
    expect(general).toContain(
      "if: always() && matrix.family != 'mutation-rust'",
    );
    expect(general).toContain("path: |\n");
    for (const root of [
      "${{ runner.temp }}/test-depth-evidence/",
      "coverage/",
      "artifacts/mutation/",
      "tests/visual-contract/output/",
    ]) {
      expect(general).toContain(root);
    }
    expect(native).toContain(
      "if: always() && matrix.family == 'mutation-rust'",
    );
    expect(native).toContain("path: ${{ runner.temp }}/test-depth-evidence/\n");
    expect(native).not.toContain("path: |");
    for (const block of [general, native]) {
      expect(block).toContain("name: test-depth-${{ matrix.label }}");
      expect(block).toContain("if-no-files-found: error");
      expect(block).toContain("retention-days: 30");
    }
  });
});
