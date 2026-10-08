import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushPackageDirs, repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();

describe("the Web Push walk's area", () => {
  it("has no Identity Web Push package graph after the Identity API removal", () => {
    expect(pushPackageDirs(root)).toEqual([]);
  });
});

describe("the Bundle budgets aggregate", () => {
  it("does not run a separate Web Push end-to-end job", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/\n {2}push-e2e:/);
    expect(ci).not.toContain("needs.changes.outputs.push == 'true'");
  });

  it("reports every bundle-area browser job on Bundle budgets", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const jobs = [
      ...ci
        .slice(ci.indexOf("\njobs:"))
        .matchAll(
          /^ {2}([a-z0-9-]+):\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gm,
        ),
    ];
    const gated = jobs
      .filter(([, , body]) =>
        /\n {4}if: needs\.changes\.outputs\.(bundle_matrix|tutorials|device_inbox|device_identity) (==|!=) '(true|\[\])'/.test(
          `\n${body}`,
        ),
      )
      .map(([, name]) => name);
    const check = jobs.find(([, name]) => name === "bundle-check")?.[2] ?? "";
    const needs = /needs: \[([^\]]*)\]/.exec(check)?.[1] ?? "";
    const listed = needs.split(",").map((name) => name.trim());
    expect(gated).toEqual(
      expect.arrayContaining([
        "bundle",
        "tutorials-e2e",
        "device-inbox",
        "device-identity-e2e",
      ]),
    );
    for (const name of gated) {
      expect(listed).toContain(name);
    }
    expect(listed).toContain("changes");
  });

  it("runs the device identity walk in its own job, gated on the gate the diff reaches, and Bundle budgets still reports it", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const bundle = ci.split("  bundle:")[1]?.split("  device-inbox:")[0] ?? "";
    expect(bundle).not.toContain("verify:device-identity");
    const job =
      ci.split("  device-identity-e2e:")[1]?.split("\n  tutorials-e2e:")[0] ??
      "";
    expect(job).toContain(
      "pnpm --filter @opensesame/pages verify:device-identity",
    );
    expect(job).toContain("needs: changes");
    expect(job).toContain(
      "if: needs.changes.outputs.device_identity == 'true'",
    );
    expect(job).toContain("node scripts/lib/ci-pages-build.mjs");
    expect(job).toMatch(/timeout-minutes: 15\b/);
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toContain(
      'identity="${{ needs.device-identity-e2e.result }}"',
    );
    expect(check).toMatch(
      /case "\$identity" in\n\s+success\|skipped\) exit 0 ;;\n\s+\*\) echo[^\n]*; exit 1 ;;/,
    );
  });
});
