import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  legCommands,
  loadPackageNodes,
  planPackages,
  repoRootFromHere,
} from "./ci-affected-tests.mjs";

const root = repoRootFromHere();
const packages = loadPackageNodes(root);

describe("the TypeScript job's legs", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const job = ci.split("  typescript-tests:")[1]?.split("\n  bundle:")[0] ?? "";
  const legs = (job.split("        leg:\n")[1] ?? "")
    .split("    services:")[0]
    .split("\n")
    .map((line) => /^ {10}- (\S+)$/.exec(line)?.[1])
    .filter(Boolean);
  const pagesPlan = planPackages(["apps/pages/src/main.tsx"], packages);
  const everything = { ...pagesPlan, scope: "all", packages: [] };
  const flat = (plan, leg) =>
    legCommands(plan, leg).map(([c, a]) => `${c} ${a.join(" ")}`);

  it("is a matrix whose legs the runner understands, and no leg is the whole job", () => {
    expect(legs.length).toBeGreaterThan(3);
    expect(job).toContain("fail-fast: false");
    expect(job).toContain("TS_LEG:");
    for (const leg of legs) {
      const named = leg === "static" ? "typecheck" : leg;
      expect(() => legCommands(pagesPlan, named), leg).not.toThrow();
    }
    expect(Number(/timeout-minutes: (\d+)/.exec(job)?.[1])).toBeLessThanOrEqual(
      10,
    );
    // The required check still reads the whole matrix.
    const gate =
      ci.split("  typescript:\n")[1]?.split("  bundle-check:")[0] ?? "";
    expect(gate).toContain("needs.typescript-tests.result");
  });

  it("shards Pages' own suite into slices that cover it once and only once", () => {
    const shards = legs
      .map((leg) => /^pages:(\d+)\/(\d+)$/.exec(leg))
      .filter(Boolean)
      .map(([, at, of]) => [Number(at), Number(of)]);
    expect(shards.length).toBeGreaterThan(1);
    const count = shards[0][1];
    expect(shards.map(([, of]) => of)).toEqual(shards.map(() => count));
    expect(shards.map(([at]) => at).sort()).toEqual(
      Array.from({ length: count }, (_, at) => at + 1),
    );
  });

  it("runs the static checks and the Postgres suites in one leg each, not in every leg", () => {
    const step = (name) =>
      job.split("      - name: ").find((part) => part.startsWith(name)) ?? "";
    for (const name of ["Lint (changed files)", "Quality gates"]) {
      expect(step(name), name).toContain("matrix.leg == 'static'");
    }
    for (const name of ["Repository contract", "Worker delivery"]) {
      expect(step(name), name).toContain("matrix.leg == 'tests'");
    }
  });
});

describe("the TypeScript job's command plans", () => {
  const pagesPlan = planPackages(["apps/pages/src/main.tsx"], packages);
  const everything = { ...pagesPlan, scope: "all", packages: [] };
  const flat = (plan, leg) =>
    legCommands(plan, leg).map(
      ([command, args]) => `${command} ${args.join(" ")}`,
    );

  it("tests every affected package but Pages in `tests`, and Pages only in its shards", () => {
    const plan = {
      ...pagesPlan,
      packages: ["@opensesame/app-core", "@opensesame/pages"],
    };
    const tests = flat(plan, "tests").join(" ");
    expect(tests).toContain("--filter=@opensesame/app-core");
    expect(tests).not.toContain("--filter=@opensesame/pages");
    const shard = flat(plan, "pages:2/4").join(" | ");
    expect(shard).toContain("--shard=2/4");
    expect(shard).not.toContain("node --test");
    expect(flat(plan, "pages:1/4").join(" | ")).toContain(
      "node --test server/test/*.test.mjs",
    );
    // Dependencies are built first, as `turbo run test` would.
    expect(flat(plan, "pages:2/4")[0]).toContain(
      "build --filter=@opensesame/pages^...",
    );
  });

  it("does nothing in a leg the diff does not touch", () => {
    const controlPlane = planPackages(
      ["packages/control-plane/src/app.ts"],
      packages,
    );
    expect(legCommands(controlPlane, "pages:1/4")).toEqual([]);
    expect(
      legCommands({ ...pagesPlan, verifyExperience: false }, "experience"),
    ).toEqual([]);
    expect(legCommands({ scope: "none", packages: [] }, "typecheck")).toEqual(
      [],
    );
  });

  it("everything-in-one-go (`all`) is what the job used to run, and `all` scope tests the rest apart from Pages", () => {
    const plan = {
      ...pagesPlan,
      packages: ["@opensesame/app-core", "@opensesame/pages"],
    };
    expect(flat(plan, "all")).toEqual([
      "pnpm exec turbo run typecheck test --concurrency=4 --filter=@opensesame/app-core --filter=@opensesame/pages",
    ]);
    expect(flat(everything, "tests")).toEqual([
      "pnpm exec turbo run test --concurrency=4 --filter=!@opensesame/pages",
    ]);
    expect(flat(everything, "typecheck")).toEqual(["pnpm typecheck"]);
  });

  it("refuses a leg it does not know", () => {
    expect(() => legCommands(pagesPlan, "pages")).toThrow(
      /unknown TypeScript leg/,
    );
  });
});
