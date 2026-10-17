// ops/github/governance.mjs end to end against a stand-in `gh`: which
// rulesets it would write, and when --verify passes. The stand-in keeps the
// repository's state in a JSON file and logs every write.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const spec = (name) =>
  JSON.parse(readFileSync(join(root, "ops/github", name), "utf8"));
const branchPolicy = spec("default-branch.json");
const tagPolicy = spec("release-tags.json");

const work = mkdtempSync(join(tmpdir(), "governance-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const state = join(work, "state.json");
const writes = join(work, "writes.jsonl");

// `gh api <path> [--method M] [--input -]` over the state file.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const [, , verb, path, , method = "GET", input] = process.argv;
if (verb !== "api") process.exit(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const body = input ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
const repo = "repos/Tyler-R-Kendrick/OpenSesame";
const bare = path.split("?")[0];
const out = (value) => process.stdout.write(JSON.stringify(value));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
if (method !== "GET") {
  fs.appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ method, path: bare, body }) + "\\n");
  if (bare === repo + "/rulesets") {
    state.rulesets.push({ ...body, id: state.rulesets.length + 10 });
    save();
  } else if (bare.startsWith(repo + "/rulesets/")) {
    const id = Number(bare.split("/").pop());
    state.rulesets = state.rulesets.map((r) => (r.id === id ? { ...body, id } : r));
    save();
  }
  process.exit(0);
}
if (bare === repo) out({ default_branch: "main", allow_auto_merge: true });
else if (bare === repo + "/rulesets") out(state.rulesets.map(({ id, name }) => ({ id, name })));
else if (bare.startsWith(repo + "/rulesets/")) out(state.rulesets.find((r) => r.id === Number(bare.split("/").pop())));
else if (bare === repo + "/environments/github-pages") out({ protection_rules: [], can_admins_bypass: false, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
else if (bare.endsWith("/deployment-branch-policies")) out({ branch_policies: [{ id: 1, type: "branch", name: "main" }] });
else if (bare === repo + "/branches/main") out({ protected: true });
else { process.stderr.write("unexpected " + path); process.exit(1); }
`;

const live = (...policies) =>
  policies.map((policy, i) => ({ ...policy, id: i + 1 }));
const setState = (rulesets) => {
  writeFileSync(state, JSON.stringify({ rulesets }));
  writeFileSync(writes, "");
};
const written = () =>
  readFileSync(writes, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function governance(mode) {
  const bin = join(work, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync("node", ["ops/github/governance.mjs", mode], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  const first = run.stdout.trim().split("\n")[0];
  return { ...run, plan: first ? JSON.parse(first) : null };
}

describe("governance.mjs", () => {
  beforeEach(() => setState([]));

  it("plans both rulesets in a dry run and writes nothing", () => {
    const run = governance("--dry-run");
    expect(run.status).toBe(0);
    expect(run.plan).toMatchObject({
      ruleset: "create",
      release_tags: "create",
    });
    expect(written()).toEqual([]);
  });

  it("fails --verify while the release tag ruleset is missing", () => {
    setState(live(branchPolicy));
    const run = governance("--verify");
    expect(run.plan).toMatchObject({ ruleset: "none", release_tags: "create" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("governance verification failed");
  });

  it("fails --verify while the release tag ruleset has drifted", () => {
    setState(live(branchPolicy, { ...tagPolicy, enforcement: "disabled" }));
    const run = governance("--verify");
    expect(run.plan.release_tags).toBe("update");
    expect(run.status).not.toBe(0);
  });

  it("passes --verify with both in place, and names the tag ruleset", () => {
    setState(live(branchPolicy, tagPolicy));
    const run = governance("--verify");
    expect(run.status).toBe(0);
    expect(run.plan).toMatchObject({ ruleset: "none", release_tags: "none" });
    const verified = JSON.parse(run.stdout.trim().split("\n").pop());
    expect(verified).toMatchObject({
      verified: true,
      release_tags_ruleset_id: 2,
    });
  });

  it("applies the missing rulesets, as written in the spec files, and then verifies", () => {
    const run = governance("--apply");
    expect(run.status).toBe(0);
    const rulesets = written().filter((w) => w.path.endsWith("/rulesets"));
    expect(rulesets.map((w) => [w.method, w.body])).toEqual([
      ["POST", branchPolicy],
      ["POST", tagPolicy],
    ]);
    expect(run.stdout).toContain('"verified":true');
  });

  it("updates only the tag ruleset when only it drifted", () => {
    setState(
      live(branchPolicy, { ...tagPolicy, rules: [{ type: "creation" }] }),
    );
    const run = governance("--apply");
    expect(run.status).toBe(0);
    const rulesets = written().filter((w) => w.path.includes("/rulesets"));
    expect(
      rulesets.map((w) => [w.method, w.path.split("/").pop(), w.body]),
    ).toEqual([["PUT", "2", tagPolicy]]);
  });
});
