import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const file = join(root, ".github/workflows/container-build-pr.yml");
const yaml = readFileSync(file, "utf8");

describe("container build on a pull request", () => {
  it("builds the compose image and does not push", () => {
    expect(yaml).toMatch(/^on:\n {2}pull_request:\n {2}workflow_dispatch:\n/m);
    expect(yaml).toContain("contents: read");
    expect(yaml).not.toMatch(/packages:\s*write/);
    expect(yaml).not.toContain("push: true");
    expect(yaml).toContain("push: false");
    expect(yaml).toContain("timeout-minutes: 45");
    expect(yaml).toContain("file: ops/compose/Dockerfile");
    expect(yaml).toContain("context: .");
    expect(yaml).toContain("opensesame:pr-");
    expect(yaml).toContain("opensesame:ci");
    expect(yaml).toContain("persist-credentials: false");
    expect(yaml).toContain(
      "uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0",
    );
  });

  it("is a TypeScript-area workflow, not a browser or Rust gate", () => {
    expect(areasForPaths([".github/workflows/container-build-pr.yml"])).toEqual(
      {
        typescript: true,
        bundle: false,
        rust: false,
        mtls: false,
        push: false,
      },
    );
  });
});
