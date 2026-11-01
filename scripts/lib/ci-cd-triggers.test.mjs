import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const read = (name) =>
  readFileSync(join(repoRootFromHere(), ".github/workflows", name), "utf8");

function job(text, id) {
  return (
    text.split(`\n  ${id}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ""
  );
}

describe("delivery authorization qualification", () => {
  it("qualifies CUA browser tests in dev and prerelease instead of trunk", () => {
    for (const name of ["full-suite.yml", "ci-prerelease-checks.yml"]) {
      const workflow = read(name);
      expect(workflow).toContain(
        "npm run test:e2e -w @opensesame/cua-password-reset",
      );
      expect(workflow).toContain(
        "AGENT_BROWSER_CHROME: /usr/bin/google-chrome",
      );
    }
    expect(read("ci.yml")).not.toContain("cua-password-reset test:e2e");
  });
  it("qualifies sandbox browser tests in candidate delivery workflows", () => {
    for (const name of ["full-suite.yml", "ci-prerelease-checks.yml"]) {
      const workflow = read(name);
      expect(workflow).toContain(
        "npm run test:e2e -w @opensesame/agent-sandboxes",
      );
      expect(workflow).toContain(
        "AGENT_BROWSER_CHROME: /usr/bin/google-chrome",
      );
    }
    const prerelease = read("ci-prerelease-checks.yml");
    expect(prerelease).toContain(
      "contains(steps.affected.outputs.packages, '@opensesame/agent-sandboxes')",
    );
    expect(read("ci.yml")).not.toContain("agent-sandboxes test:e2e");
  });
  it("pins sync authorization to the candidate without cancelling another delivery", () => {
    const workflow = read("sync-target-security.yml");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toMatch(/source_sha:\n(?:.*\n)*? {8}required: true/);
    expect(workflow).toContain("ref: ${{ inputs.source_sha || github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("inputs.source_sha && github.run_id");
    expect(workflow).toContain("cancel-in-progress: ${{ !inputs.source_sha }}");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/^ {2}(?:push|pull_request|merge_group):/m);
  });

  it("requires sync authorization before prerelease qualification can succeed", () => {
    const workflow = read("ci-prerelease-checks.yml");
    const sync = job(workflow, "sync-target-security");
    expect(sync).toContain("needs: admission");
    expect(sync).toContain(
      "uses: ./.github/workflows/sync-target-security.yml",
    );
    expect(sync).toContain("source_sha: ${{ inputs.source_sha }}");
    const required = job(workflow, "gate");
    expect(required).toMatch(/needs: \[[^\n]*\bsync-target-security\b/);
    expect(required).toContain("toJSON(needs)");
  });
});
