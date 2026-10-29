import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const file = join(root, ".github/workflows/container-build-pr.yml");
const yaml = readFileSync(file, "utf8");

describe("candidate-bound container validation", () => {
  it("builds the compose image and does not push", () => {
    expect(yaml).toContain("  workflow_call:");
    expect(yaml).not.toMatch(/^ {2}(?:pull_request|push|schedule):/m);
    expect(yaml).toContain("ref: ${{ inputs.source_sha }}");
    expect(yaml).toContain("contents: read");
    expect(yaml).not.toMatch(/packages:\s*write/);
    expect(yaml).not.toContain("push: true");
    expect(yaml).toContain("push: false");
    expect(yaml).toContain("timeout-minutes: 45");
    expect(yaml).toContain("file: ops/compose/Dockerfile");
    expect(yaml).toContain("context: .");
    expect(yaml).toContain("opensesame:candidate-${{ inputs.source_sha }}");
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

const auxiliaries = [
  "autofill-browser.yml",
  "codeql.yml",
  "sync-target-security.yml",
];
describe("heavy auxiliary suites are CD concerns", () => {
  it("keeps every automatic trunk workflow confined to affected-build CI", () => {
    const directory = join(root, ".github/workflows");
    const automatic = readdirSync(directory)
      .filter((name) => name.endsWith(".yml"))
      .filter((name) =>
        /^ {2}(?:pull_request|pull_request_target|push|merge_group):/m.test(
          readFileSync(join(directory, name), "utf8"),
        ),
      )
      .sort();
    expect(automatic).toEqual(["ci.yml"]);
  });

  it.each(auxiliaries)("retains candidate qualification in %s", (name) => {
    const workflow = readFileSync(
      join(root, ".github/workflows", name),
      "utf8",
    );
    expect(workflow).toContain("  workflow_call:");
    expect(workflow).toMatch(
      /source_sha:\n(?:[^\n]*\n){0,3}[^\n]*required: true/,
    );
    expect(workflow).not.toMatch(
      /^ {2}(?:pull_request|pull_request_target|push|merge_group):/m,
    );
    expect(workflow).toContain("ref: ${{ inputs.source_sha");
  });

  it("keeps drafts failing all three required CI reporters", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci.match(/DRAFT: \$\{\{ needs.changes.outputs.draft \}\}/g),
    ).toHaveLength(3);
    expect(
      ci.match(/run: node scripts\/lib\/ci-required-result.mjs/g),
    ).toHaveLength(3);
    expect(ci).toContain(
      "draft: ${{ github.event.pull_request.draft == true && 'true' || 'false' }}",
    );
  });
});
