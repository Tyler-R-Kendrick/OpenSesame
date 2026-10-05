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
    // Cut into interleaved slices and one leg for the gates, so no job walks
    // the whole library: every slice i/n of the same n appears once, and the
    // walk is told exactly the slice the matrix names.
    const legs = [
      ...(/shard: \[([^\]]+)\]/.exec(job)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((leg) => leg[1]);
    const slices = legs
      .filter((leg) => leg !== "gates")
      .map((leg) => leg.split("/").map(Number));
    expect(legs.filter((leg) => leg === "gates")).toHaveLength(1);
    expect(slices.length).toBeGreaterThan(1);
    const count = slices[0][1];
    expect(slices.map(([, of]) => of)).toEqual(slices.map(() => count));
    expect(slices.map(([at]) => at)).toEqual(
      Array.from({ length: count }, (_, at) => at + 1),
    );
    expect(job).toContain("TUTORIALS_SHARD: ${{ matrix.shard }}");
    const limit = Number(/timeout-minutes: (\d+)/.exec(job)?.[1]);
    expect(limit).toBeLessThanOrEqual(15);
    expect(job).toContain("needs: changes");
    expect(job).toContain("if: needs.changes.outputs.bundle == 'true'");
    expect(job).toContain(
      "pnpm exec turbo run build --filter=@opensesame/pages",
    );
    const check =
      ci.split("  bundle-check:")[1]?.split("  rust-check:")[0] ?? "";
    expect(check).toContain('tutorials="${{ needs.tutorials-e2e.result }}"');
    expect(check).toMatch(
      /case "\$tutorials" in\n\s+success\|skipped\) ;;\n\s+\*\) echo[^\n]*; exit 1 ;;/,
    );
  });
});
