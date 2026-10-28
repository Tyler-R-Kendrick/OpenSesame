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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

// Each case starts node (and the stand-in gh a dozen times) on a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

const root = repoRootFromHere();
const spec = (name) =>
  JSON.parse(readFileSync(join(root, "ops/github", name), "utf8"));
const branchPolicy = spec("default-branch.json");
const tagPolicy = spec("release-tags.json");
const tagCreationPolicy = spec("release-tag-creation.json");

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
if (process.env.GOVERNANCE_REFUSE && body?.name === process.env.GOVERNANCE_REFUSE) process.exit(1);
if (method !== "GET") {
  fs.appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ method, path: bare, body }) + "\\n");
  if (bare === repo + "/rulesets") {
    const created = { ...body, id: state.rulesets.length + 10 };
    state.rulesets.push(created);
    save();
    out(created);
  } else if (bare.startsWith(repo + "/rulesets/")) {
    const id = Number(bare.split("/").pop());
    const updated = { ...body, id };
    state.rulesets = state.rulesets.map((r) => (r.id === id ? updated : r));
    save();
    out(updated);
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

function governance(mode, extraEnv = {}) {
  const bin = join(work, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync("node", ["ops/github/governance.mjs", mode], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
    encoding: "utf8",
  });
  const first = run.stdout.trim().split("\n")[0];
  return { ...run, plan: first ? JSON.parse(first) : null };
}

describe("governance.mjs", () => {
  beforeEach(() => setState([]));

  it("plans the default branch and both tag rulesets in a dry run and writes nothing", () => {
    const run = governance("--dry-run");
    expect(run.status).toBe(0);
    expect(run.plan).toMatchObject({
      ruleset: "create",
      release_tags: "create",
      release_tag_creation: "create",
      release_tag_bootstrap: "owner-only-first",
    });
    expect(written()).toEqual([]);
  });

  it("fails --verify while the release tag ruleset is missing", () => {
    setState(live(branchPolicy, tagCreationPolicy));
    const run = governance("--verify");
    expect(run.plan).toMatchObject({ ruleset: "none", release_tags: "create" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("governance verification failed");
  });

  it("fails --verify while the release tag ruleset has drifted", () => {
    setState(
      live(
        branchPolicy,
        { ...tagPolicy, enforcement: "disabled" },
        tagCreationPolicy,
      ),
    );
    const run = governance("--verify");
    expect(run.plan.release_tags).toBe("update");
    expect(run.status).not.toBe(0);
  });

  it("passes --verify with all three policies in place and names both tag rulesets", () => {
    setState(live(branchPolicy, tagPolicy, tagCreationPolicy));
    const run = governance("--verify");
    expect(run.status).toBe(0);
    expect(run.plan).toMatchObject({ ruleset: "none", release_tags: "none" });
    const verified = JSON.parse(run.stdout.trim().split("\n").pop());
    expect(verified).toMatchObject({
      verified: true,
      release_tags_ruleset_id: 2,
      release_tag_creation_ruleset_id: 3,
    });
  });
});

describe("governance.mjs activation", () => {
  beforeEach(() => setState([]));

  it("applies the missing rulesets, as written in the spec files, and then verifies", () => {
    const run = governance("--apply");
    expect(run.status).toBe(0);
    const rulesets = written().filter((w) => w.path.includes("/rulesets"));
    expect(rulesets.map((w) => [w.method, w.body])).toEqual([
      ["POST", branchPolicy],
      [
        "POST",
        { ...tagPolicy, rules: [{ type: "creation" }, ...tagPolicy.rules] },
      ],
      ["POST", tagCreationPolicy],
      ["PUT", tagPolicy],
    ]);
    expect(rulesets[3].path).toBe(
      "repos/Tyler-R-Kendrick/OpenSesame/rulesets/11",
    );
    expect(run.stdout).toContain('"verified":true');
  });

  it("writes the tag ruleset after the Pages policy, so a refusal skips nothing", () => {
    const run = governance("--apply");
    expect(run.status).toBe(0);
    const paths = written().map((w) => w.path);
    const pages = paths.findIndex((p) =>
      p.endsWith("/environments/github-pages"),
    );
    const tag = written().findIndex((w) => w.body?.name === tagPolicy.name);
    expect(pages).toBeGreaterThan(-1);
    expect(tag).toBeGreaterThan(pages);
  });

  it("reports a refused tag ruleset at the end, after the other steps ran", () => {
    const run = governance("--apply", { GOVERNANCE_REFUSE: tagPolicy.name });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("release tag rulesets were not fully written");
    const done = written().map(
      (w) => `${w.method} ${w.path.split("/").slice(-2).join("/")}`,
    );
    expect(done).toContain("PUT environments/github-pages");
    expect(written().some((w) => w.body?.name === branchPolicy.name)).toBe(
      true,
    );
  });

  it("calls a tag ruleset GitHub echoed defaults on in place", () => {
    const echoed = tagPolicy.rules.map((rule) =>
      rule.type === "update"
        ? { ...rule, parameters: { update_allows_fetch_and_merge: false } }
        : rule,
    );
    setState(
      live(branchPolicy, { ...tagPolicy, rules: echoed }, tagCreationPolicy),
    );
    const run = governance("--verify");
    expect(run.plan.release_tags).toBe("none");
    expect(run.status).toBe(0);
  });

  it("updates only the tag ruleset when only it drifted", () => {
    setState(
      live(
        branchPolicy,
        { ...tagPolicy, rules: [{ type: "creation" }] },
        tagCreationPolicy,
      ),
    );
    const run = governance("--apply");
    expect(run.status).toBe(0);
    const rulesets = written().filter((w) => w.path.includes("/rulesets"));
    expect(
      rulesets.map((w) => [w.method, w.path.split("/").pop(), w.body]),
    ).toEqual([["PUT", "2", tagPolicy]]);
  });
});

it("fails verification while the separate creation policy is missing", () => {
  setState(live(branchPolicy, tagPolicy));
  const run = governance("--verify");
  expect(run.plan).toMatchObject({
    release_tags: "none",
    release_tag_creation: "create",
  });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("governance verification failed");
  expect(written()).toEqual([]);
});

it("updates only the creation policy when only its allowed creator drifted", () => {
  setState(
    live(branchPolicy, tagPolicy, {
      ...tagCreationPolicy,
      bypass_actors: tagPolicy.bypass_actors,
    }),
  );
  const before = governance("--verify");
  expect(before.status).not.toBe(0);
  expect(before.plan).toMatchObject({
    release_tags: "none",
    release_tag_creation: "update",
  });
  expect(written()).toEqual([]);
  const run = governance("--apply");
  expect(run.status).toBe(0);
  const rulesets = written().filter((w) => w.path.includes("/rulesets"));
  expect(
    rulesets.map((w) => [w.method, w.path.split("/").pop(), w.body]),
  ).toEqual([["PUT", "3", tagCreationPolicy]]);
  expect(run.stdout).toContain('"verified":true');
});

it("retains owner-only bootstrap protection when the creation exception is refused", () => {
  setState([]);
  const run = governance("--apply", {
    GOVERNANCE_REFUSE: tagCreationPolicy.name,
  });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("release tag rulesets were not fully written");
  expect(run.stderr).toContain("governance verification failed");
  expect(run.stdout).not.toContain('"verified":true');
  const tags = JSON.parse(readFileSync(state, "utf8")).rulesets.find(
    (r) => r.name === tagPolicy.name,
  );
  expect(tags.rules).toEqual([{ type: "creation" }, ...tagPolicy.rules]);
  expect(tags.bypass_actors).toEqual(tagPolicy.bypass_actors);
  const rulesets = written().filter((w) => w.path.includes("/rulesets"));
  expect(rulesets.map((w) => w.body.name)).toEqual([
    branchPolicy.name,
    tagPolicy.name,
  ]);
});
