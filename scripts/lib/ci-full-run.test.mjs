import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";
import { loadShards } from "./ci-gates.mjs";

const root = repoRootFromHere();
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

function selector(env) {
  const out = execFileSync(
    "node",
    [join(root, "scripts/lib/ci-changed-areas.mjs")],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

describe("the whole-repository run", () => {
  it("runs on a push to main and on demand, with no pull request to diff", () => {
    const on = ci.split("\njobs:")[0];
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]/);
    expect(on).toContain("workflow_dispatch:");
  });

  it("verifies pull-request signatures only on a pull request", () => {
    const step = ci
      .split("name: Verify merge-required commit signatures")[1]
      ?.split("- name:")[0];
    expect(step).toContain("if: github.event_name == 'pull_request'");
  });

  it("does not cancel a push run for the next one", () => {
    expect(ci).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("selects every area, every shard and every job when it has no base to diff", () => {
    const out = selector({});
    for (const area of ["typescript", "bundle", "rust", "mtls", "push"]) {
      expect(out[area], area).toBe("true");
    }
    for (const job of [
      "tutorials",
      "device_inbox",
      "device_identity",
      "live_join",
    ]) {
      expect(out[job], job).toBe("true");
    }
    expect(JSON.parse(out.bundle_matrix)).toEqual(loadShards(root));
  });

  it("tests every package and crate when it has no base to diff against", () => {
    for (const command of ["plan", "cargo"]) {
      const out = execFileSync(
        "node",
        [join(root, "scripts/lib/ci-affected-tests.mjs"), command],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      expect(out).toContain("scope=all");
    }
  });
});
