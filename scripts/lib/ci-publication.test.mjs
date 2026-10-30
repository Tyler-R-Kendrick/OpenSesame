import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { parse } = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
)("yaml");
const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  );

describe("publication authority", () => {
  it.each(["publish-npm", "publish-containers"])(
    "%s is a manual failure with no registry publication authority",
    (name) => {
      const definition = workflow(name);
      expect(Object.keys(definition.on)).toEqual(["workflow_dispatch"]);
      expect(definition.permissions).toEqual({ contents: "read" });
      expect(definition.env).toBeUndefined();
      expect(Object.keys(definition.jobs)).toEqual(["retired"]);
      const job = definition.jobs.retired;
      expect(job.if).toBeUndefined();
      expect(job.environment).toBeUndefined();
      expect(job.permissions).toBeUndefined();
      expect(job.env).toBeUndefined();
      expect(job.uses).toBeUndefined();
      expect(job.steps).toHaveLength(1);
      expect(Object.keys(job.steps[0]).sort()).toEqual(["name", "run"]);
      expect(job.steps[0].run).toContain("::error::");
      expect(job.steps[0].run).toMatch(/^\s*exit 1\s*$/m);
      expect(JSON.stringify(definition)).not.toMatch(
        /secrets\.|publish-packages\.mjs|\b(?:npm|pnpm)\s+publish|\bdocker\s+(?:login|push|build)|docker\/(?:login|build-push)-action/,
      );
    },
  );

  it("limits the protected release credential to draft creation", () => {
    const definition = workflow("release-publish");
    const stage = definition.jobs.stage;
    expect(stage.environment.name).toBe("release");
    expect(definition.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(stage.env?.GH_TOKEN).toBeUndefined();
    const protectedSteps = stage.steps.filter((step) =>
      JSON.stringify(step).includes("secrets.RELEASE_PUBLISH_TOKEN"),
    );
    expect(protectedSteps.map((step) => step.name)).toEqual([
      "Require the protected publication credential",
      "Create or resume the owned draft with exactly the allowed assets",
    ]);
    for (const step of protectedSteps) {
      expect(step.env).toEqual({
        GH_TOKEN: "${{ secrets.RELEASE_PUBLISH_TOKEN }}",
      });
    }
    const qualification = stage.steps.find(
      (step) =>
        step.name ===
        "Revalidate original build and every prerequisite receipt",
    );
    expect(qualification).toBeDefined();
    expect(qualification.env?.GH_TOKEN).toBeUndefined();
  });

  it("retains the upstream registry controls as prerequisites for a future integration", () => {
    const guide = readFileSync(
      new URL("../release/README.md", import.meta.url),
      "utf8",
    );
    expect(guide).toContain("publish-packages.mjs");
    expect(guide).toContain("shell-free");
    expect(guide).toContain("GHCR_PUBLISH_TOKEN");
    expect(guide).toContain("container-release");
    expect(guide).toMatch(/automatic Actions token write access/);
    expect(guide).toMatch(/immutable artifact inventory, qualification/);
    expect(guide).toContain("does not activate the retired workflow");
  });
});
