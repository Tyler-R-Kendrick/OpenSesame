import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { buildSteps } from "./ci-pages-build.mjs";

describe("ci pages build", () => {
  it("is the package's own build without the typecheck", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRootFromHere(), "apps/pages/package.json"), "utf8"),
    );
    const steps = buildSteps(pkg.scripts.build);
    expect(steps).toContain("vite build");
    expect(steps).not.toContain("tsc --noEmit");
    expect(steps.length).toBe(pkg.scripts.build.split("&&").length - 1);
  });

  it("drops only the typecheck", () => {
    expect(buildSteps("a && tsc --noEmit && b")).toEqual(["a", "b"]);
  });
});
