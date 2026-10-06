import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();

describe("the tutorial walk's CI job", () => {
  it("runs the tutorial walk in its own job per width, gated on the bundle area, and Bundle budgets still reports it", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const bundle = ci.split("  bundle:")[1]?.split("  push-e2e:")[0] ?? "";
    // Out of the twenty-minute bundle job, which the walk would not fit in.
    expect(bundle).not.toContain("verify:tutorials");
    const job = ci.split("  tutorials-e2e:")[1]?.split("\n  rust:")[0] ?? "";
    expect(job).toContain("pnpm --filter @opensesame/pages verify:tutorials");
    expect(job).toContain("TUTORIALS_WIDTHS: ${{ matrix.width }}");
    expect(job).toContain("width: [1280, 390]");
    // A third of the library per leg: the first third also walks the passes
    // that are not a tutorial, so each runs in exactly one leg.
    expect(job).toContain('shard: ["1/3", "2/3", "3/3"]');
    expect(job).toContain("TUTORIALS_SHARD: ${{ matrix.shard }}");
    expect(job).toContain("needs: changes");
    expect(job).toContain("if: needs.changes.outputs.tutorials == 'true'");
    expect(job).toContain("node scripts/lib/ci-pages-build.mjs");
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toContain('tutorials="${{ needs.tutorials-e2e.result }}"');
    expect(check).toMatch(
      /case "\$tutorials" in\n\s+success\|skipped\) ;;\n\s+\*\) echo[^\n]*; exit 1 ;;/,
    );
  });
});
