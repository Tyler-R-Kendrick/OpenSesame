import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/publish-containers.yml", import.meta.url), "utf8");
const script = new URL("../release/tag-check.sh", import.meta.url).pathname;
const guard = workflow.match(/    if: >-\n([\s\S]*?)    runs-on:/)[1].trim();
const allowed = new Function("github", "startsWith", `return (${guard});`);
const startsWith = (value, prefix) => value.startsWith(prefix);

test("dispatch authorization rejects branches and tags other than the main branch", () => {
  for (const ref of ["refs/heads/feature", "refs/heads/v1.0.0", "refs/tags/main", "refs/tags/v1.0.0"]) {
    assert.equal(allowed({ event_name: "workflow_dispatch", ref }, startsWith), false, ref);
  }
  assert.equal(allowed({ event_name: "workflow_dispatch", ref: "refs/heads/main" }, startsWith), true);
  assert.equal(allowed({ event_name: "push", ref_type: "branch", ref: "refs/heads/v1.0.0" }, startsWith), false);
  assert.equal(allowed({ event_name: "push", ref_type: "tag", ref: "refs/tags/v1.0.0" }, startsWith), true);
});

test("write permission follows read-only verification and an immutable checkout", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  const [source, publish] = workflow.split("  ghcr:\n");
  assert.doesNotMatch(source, /packages: write/);
  assert.match(source, /contents: read/);
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /tag-check\.sh verify "\$TAG" "\$EVENT_SHA"/);
  assert.match(source, /merge-base --is-ancestor "\$sha" refs\/remotes\/origin\/main/);
  assert.match(publish, /needs: source/);
  assert.match(publish, /ref: \$\{\{ needs\.source\.outputs\.sha \}\}/);
  assert.ok(publish.indexOf("Check the publication checkout") < publish.indexOf("Log in to GHCR"));
  assert.match(publish, /push: true/);
  assert.match(publish, /OPENSESAME_FEATURES=\$\{\{ inputs\.features \}\}/);
});

test("release verification accepts main and annotated tags, rejects off-main commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "container-source-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  const verify = (sha) => spawnSync("bash", [script, "verify", "v0.1.0", sha], { cwd: dir, env, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "Cargo.toml"), '[workspace.package]\nversion = "0.1.0"\n');
    git("add", "."); git("commit", "-qm", "main");
    const main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    assert.equal(verify(main).status, 0);
    git("tag", "-a", "v0.1.0", "-m", "release");
    assert.equal(verify(git("rev-parse", "refs/tags/v0.1.0")).stdout.trim(), main);
    git("checkout", "-qb", "feature");
    writeFileSync(join(dir, "unreviewed"), "branch code");
    git("add", "."); git("commit", "-qm", "feature");
    assert.notEqual(verify(git("rev-parse", "HEAD")).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
