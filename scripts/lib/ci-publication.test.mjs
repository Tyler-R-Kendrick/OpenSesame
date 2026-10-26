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
  it("passes npm selections as data and publishes only the immutable main revision", () => {
    const job = workflow("publish-npm").jobs.publish;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.steps[0].with.ref).toBe("${{ github.sha }}");
    const publish = job.steps.find(
      (step) => step.name === "Publish selected packages",
    );
    expect(publish.env.NPM_PACKAGES).toBe("${{ inputs.packages }}");
    expect(publish.run).not.toContain("${{");
    expect(publish.run).toContain("node scripts/release/publish-packages.mjs");
  });

  it("verifies a main commit or version tag before granting container write authority", () => {
    const definition = workflow("publish-containers");
    expect(definition.permissions).toEqual({ contents: "read" });
    const { verify, ghcr } = definition.jobs;
    expect(verify.if).toBe(
      "github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')",
    );
    expect(verify.steps[0].with["fetch-depth"]).toBe(0);
    const check = verify.steps.find((step) => step.id === "check");
    expect(check.run).toContain(
      'scripts/release/tag-check.sh verify "$TAG" "$EVENT_SHA"',
    );
    expect(check.run).toContain(
      'git merge-base --is-ancestor "$sha" refs/remotes/origin/main',
    );
    expect(check.run).not.toContain("${{");
    expect(ghcr.needs).toBe("verify");
    expect(ghcr.permissions.packages).toBeUndefined();
    expect(ghcr.environment).toBe("container-release");
    expect(
      ghcr.steps.find((step) => step.name === "Log in to GHCR").with.password,
    ).toBe("${{ secrets.GHCR_PUBLISH_TOKEN }}");
    expect(ghcr.steps[0].with.ref).toBe("${{ needs.verify.outputs.sha }}");
  });
});
