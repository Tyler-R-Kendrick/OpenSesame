import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const file = join(root, ".github/workflows/container-build-pr.yml");
const yaml = readFileSync(file, "utf8");

describe("container build on a pull request", () => {
  it("builds the compose image and does not push", () => {
    expect(yaml).toMatch(
      /^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]\n {2}workflow_dispatch:\n/m,
    );
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

const auxiliaries = [
  "autofill-browser.yml",
  "codeql.yml",
  "complete-verify.yml",
  "container-build-pr.yml",
  "fuzz-and-coverage.yml",
  "native-platform-validation.yml",
  "password-parity.yml",
  "sync-target-security.yml",
];
const readyTypes =
  "    types: [opened, synchronize, reopened, ready_for_review]";
const draftGuard =
  "    if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}";

function expectDraftAdmission(source) {
  expect(source).toContain(`  pull_request:\n${readyTypes}\n`);
  const jobs = source.split("\njobs:\n")[1];
  expect(jobs).toBeDefined();
  const starts = [...jobs.matchAll(/^ {2}[a-zA-Z][a-zA-Z0-9_-]*:\n/gm)];
  expect(starts.length).toBeGreaterThan(0);
  for (const [index, start] of starts.entries()) {
    const block = jobs.slice(start.index, starts[index + 1]?.index);
    expect(block.split("\n")).toContain(draftGuard);
  }
}

describe("auxiliary pull-request suites respect draft stacks", () => {
  it("covers every PR workflow outside the required CI reporter", () => {
    const directory = join(root, ".github/workflows");
    const actual = readdirSync(directory)
      .filter((name) => name.endsWith(".yml") && name !== "ci.yml")
      .filter((name) =>
        /^ {2}pull_request:/m.test(readFileSync(join(directory, name), "utf8")),
      )
      .sort();
    expect(actual).toEqual(auxiliaries);
  });

  it.each(auxiliaries)("guards all jobs and starts ready PRs in %s", (name) => {
    expectDraftAdmission(
      readFileSync(join(root, ".github/workflows", name), "utf8"),
    );
  });

  it.each(auxiliaries)("rejects an unguarded job in %s", (name) => {
    const source = readFileSync(join(root, ".github/workflows", name), "utf8");
    expect(() =>
      expectDraftAdmission(source.replace(`${draftGuard}\n`, "")),
    ).toThrow();
  });

  it.each(auxiliaries)("rejects a missing ready event in %s", (name) => {
    const source = readFileSync(join(root, ".github/workflows", name), "utf8");
    expect(() =>
      expectDraftAdmission(source.replace(", ready_for_review", "")),
    ).toThrow();
  });

  it("keeps drafts failing all three required CI reporters", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci.match(/if \[ "\$\{DRAFT:-false\}" = "true" \]; then/g),
    ).toHaveLength(3);
    expect(ci).toContain(
      "draft pull request: CI runs when it is marked ready for review",
    );
  });
});
