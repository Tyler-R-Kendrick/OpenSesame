/** Published simple-git advisory regressions; no attacker command is executed. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const consumerRequire = createRequire(
  new URL("../../tests/redteam/package.json", import.meta.url),
);
const promptfooRequire = createRequire(consumerRequire.resolve("promptfoo"));
const gitEntry = promptfooRequire.resolve("simple-git");
const gitRequire = createRequire(gitEntry);
const { vulnerabilityCheck } = gitRequire("@simple-git/argv-parser");
const { simpleGit } = require(gitEntry);
const esmParser = await import(
  pathToFileURL(
    join(dirname(gitRequire.resolve("@simple-git/argv-parser")), "index.mjs"),
  ).href
);
const rejected = [
  ["push", "--receive-p=not-an-executable"],
  ["push", "--exe=not-an-executable"],
  ["-c", "include.path=/nonexistent/advisory-config", "status"],
  ["-c", "includeIf.gitdir:/tmp/.path=/nonexistent/advisory-config", "status"],
  ["-c", "trailer.review.cmd=not-an-executable", "status"],
];

test("locally hardened parser rejects abbreviated pack flags, includes and trailer command configuration", () => {
  for (const args of rejected)
    assert.ok([...vulnerabilityCheck(args, {})].length > 0, args.join(" "));
});
test("published parser classifies VISUAL as unsafe editor environment", () => {
  assert.ok(
    [...vulnerabilityCheck(["status"], { VISUAL: "not-an-executable" })].some(
      (finding) => finding.category === "allowUnsafeEditor",
    ),
  );
});
test("default simple-git guard rejects unsafe options before attempting Git execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-simple-git-guard-"));
  try {
    for (const args of rejected)
      await assert.rejects(
        simpleGit({ baseDir: directory }).raw(args),
        /not permitted|unsafe/i,
      );
    await assert.rejects(
      simpleGit({
        baseDir: directory,
        config: ["trailer.review.cmd=not-an-executable"],
      }).raw(["status"]),
      /not permitted|unsafe/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("published upgrade preserves ordinary init/status and harmless config behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-simple-git-upgrade-"));
  try {
    const git = simpleGit({ baseDir: directory, config: ["color.ui=false"] });
    await git.init();
    assert.equal((await git.status()).isClean(), true);
    assert.equal(await git.revparse(["--is-inside-work-tree"]), "true");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both runtime bundles reject every executable-option prefix without inspecting positional values", () => {
  for (const check of [vulnerabilityCheck, esmParser.vulnerabilityCheck]) {
    for (const [task, options] of [
      ["push", ["--receive-pack", "--exec"]],
      ...["clone", "fetch", "pull", "ls-remote"].map((task) => [
        task,
        ["--upload-pack"],
      ]),
    ]) {
      for (const option of options) {
        for (let length = 3; length <= option.length; length++) {
          const prefix = option.slice(0, length);
          assert.ok(
            check([task, `${prefix}=not-an-executable`], {}).some(
              (finding) => finding.category === "allowUnsafePack",
            ),
            `${task} ${prefix}`,
          );
          assert.ok(
            check([task, prefix, "not-an-executable"], {}).some(
              (finding) => finding.category === "allowUnsafePack",
            ),
            `${task} ${prefix} value`,
          );
        }
      }
    }
    for (const args of [
      ["diff", "--unified=3"],
      ["status", "--untracked-files=all"],
      ["push", "--repo=/nonexistent/local"],
      ["push", "--", "--exec=positional"],
      ["fetch", "--", "--upload-pack=positional"],
    ])
      assert.deepEqual(check(args, {}), [], args.join(" "));
  }
});
