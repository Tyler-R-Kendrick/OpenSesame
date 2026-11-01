import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { captureShotsDirectory } from "../../apps/pages/scripts/lib/evidence-paths.mjs";
import {
  assertSlot,
  readTree,
  sha256,
  validateEvidence,
  validateSlot,
} from "../lib/evidence-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const promotion = join(root, "scripts/dev/promote-evidence.mjs");
const gate = join(root, "scripts/quality/evidence-gate.mjs");
const slot = "unlock/pages/web";
// A real reviewer's login and a review of this repository; the approval rule
// itself is evidence-approval.test.mjs.
const reviewer = "Tyler-R-Kendrick";
const review =
  "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#pullrequestreview-3412345678";
function payload() {
  const files = new Map([
    ["README.md", Buffer.from("# Current unlock\n")],
    ["desktop.png", Buffer.from("reviewed capture")],
  ]);
  files.set(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        version: 1,
        status: "approved",
        sourceCommit: "a".repeat(40),
        approval: { by: reviewer, reference: review },
        files: [...files].map(([path, bytes]) => ({
          path,
          sha256: sha256(bytes),
        })),
      }),
    ),
  );
  return files;
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "evidence-policy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "Evidence tests"]);
  git(["config", "user.email", "evidence@example.test"]);
  writeFileSync(join(directory, "implementation.txt"), "implemented\n");
  git(["add", "implementation.txt"]);
  git(["commit", "-qm", "implementation"]);
  const source = git(["rev-parse", "HEAD"]);
  const run = (script, args = [], cwd = directory) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const candidate = join(directory, "work", "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, "README.md"), "# Approved current state\n");
  writeFileSync(join(candidate, "desktop.png"), "approved current capture");
  const promote = (target = slot, input = candidate, commit = source) =>
    run(promotion, [
      target,
      input,
      "--source",
      commit,
      "--approved-by",
      reviewer,
      "--approval-ref",
      review,
    ]);
  return { directory, git, candidate, promote, run };
}

test("stable slots reject dates, traversal, revisions and incorrect depth", () => {
  assert.equal(assertSlot(slot), slot);
  for (const invalid of [
    "2026-10-23-unlock/pages/web",
    "unlock/pages",
    "unlock/pages/web/phone",
    "../pages/web",
    "unlock/Pages/web",
    "unlock/pages/r3",
    "unlock-v2/pages/web",
    "unlock/pages-r3/web",
    "unlock/pages/web-round2",
  ]) {
    assert.throws(() => assertSlot(invalid));
  }
});

test("persisted inventory rejects stale hashes, unlisted files and fabricated schema", () => {
  assert.equal(validateSlot(slot, payload()).status, "approved");
  const changed = payload();
  changed.set("desktop.png", Buffer.from("unreviewed replacement"));
  assert.throws(() => validateSlot(slot, changed), /hash mismatch/u);
  const unlisted = payload();
  unlisted.set("phone.png", Buffer.from("extra capture"));
  assert.throws(() => validateSlot(slot, unlisted), /unlisted/u);
  const noApproval = payload();
  const manifest = JSON.parse(noApproval.get("manifest.json"));
  manifest.approval.reference = "";
  noApproval.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => validateSlot(slot, noApproval), /approval/u);
  const historical = payload();
  historical.set("before.png", Buffer.from("old"));
  assert.throws(() => validateSlot(slot, historical), /temporary/u);
  assert.throws(
    () =>
      validateEvidence(
        new Map([["2026-10-23-unlock/before.png", Buffer.from("old")]]),
      ),
    /location/u,
  );
});

test("promotion replaces only the approved feature slot, removes obsolete files and preserves neighbors", (t) => {
  const f = fixture(t);
  const destination = join(f.directory, "docs/evidence", slot);
  const neighbor = join(f.directory, "docs/evidence/share/pages/web");
  mkdirSync(destination, { recursive: true });
  mkdirSync(neighbor, { recursive: true });
  writeFileSync(join(destination, "obsolete.png"), "old");
  writeFileSync(join(neighbor, "untouched.txt"), "untouched");
  const result = f.promote();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...readTree(destination).keys()],
    ["README.md", "desktop.png", "manifest.json"],
  );
  assert.equal(
    readFileSync(join(neighbor, "untouched.txt"), "utf8"),
    "untouched",
  );
  rmSync(neighbor, { recursive: true });
  assert.equal(f.run(gate).status, 0);
});

test("invalid promotion and symlink input leave previous evidence intact", (t) => {
  const f = fixture(t);
  assert.equal(f.promote().status, 0);
  const destination = join(f.directory, "docs/evidence", slot);
  const original = readFileSync(join(destination, "manifest.json"), "utf8");
  writeFileSync(join(f.candidate, "before.png"), "historical");
  assert.notEqual(f.promote().status, 0);
  assert.equal(
    readFileSync(join(destination, "manifest.json"), "utf8"),
    original,
  );
  rmSync(join(f.candidate, "before.png"));
  symlinkSync(
    join(f.candidate, "desktop.png"),
    join(f.candidate, "linked.png"),
  );
  assert.notEqual(f.promote().status, 0);
  assert.equal(
    readFileSync(join(destination, "manifest.json"), "utf8"),
    original,
  );
  rmSync(join(f.candidate, "linked.png"));
  assert.notEqual(f.promote("../outside/web").status, 0);
  assert.notEqual(f.promote(slot, destination).status, 0);
  assert.notEqual(f.promote(slot, f.candidate, "b".repeat(40)).status, 0);
});

test("staged gate validates index content rather than unstaged repairs", (t) => {
  const f = fixture(t);
  assert.equal(f.promote().status, 0);
  f.git(["add", "docs/evidence"]);
  const capture = join(f.directory, "docs/evidence", slot, "desktop.png");
  writeFileSync(capture, "unstaged corruption");
  assert.equal(f.run(gate, ["--staged"]).status, 0);
  assert.notEqual(f.run(gate).status, 0);
  f.git(["add", "docs/evidence"]);
  writeFileSync(capture, "approved current capture");
  assert.notEqual(f.run(gate, ["--staged"]).status, 0);
  assert.equal(f.run(gate).status, 0);
});

test("staged gate rejects symlinks without following them", (t) => {
  const f = fixture(t);
  assert.equal(f.promote().status, 0);
  symlinkSync(
    "/does-not-exist",
    join(f.directory, "docs/evidence", slot, "linked.png"),
  );
  f.git(["add", "docs/evidence"]);
  const result = f.run(gate, ["--staged"]);
  assert.notEqual(result.status, 0);
});

test("staged gate runs from repository root when invoked inside a subdirectory", (t) => {
  const f = fixture(t);
  assert.equal(f.promote().status, 0);
  f.git(["add", "docs/evidence"]);
  assert.equal(f.run(gate, ["--staged"], f.candidate).status, 0);
  const capture = join(f.directory, "docs/evidence", slot, "desktop.png");
  writeFileSync(capture, "staged corruption");
  f.git(["add", "docs/evidence"]);
  assert.notEqual(f.run(gate, ["--staged"], f.candidate).status, 0);
});

test("gate refuses symlinked docs parent in worktree and index", (t) => {
  const f = fixture(t);
  const external = join(f.directory, "external-docs");
  mkdirSync(join(external, "evidence"), { recursive: true });
  writeFileSync(join(external, "evidence/README.md"), "# Evidence\n");
  symlinkSync(external, join(f.directory, "docs"));
  assert.notEqual(f.run(gate).status, 0);
  f.git(["add", "docs"]);
  assert.notEqual(f.run(gate, ["--staged"]).status, 0);
});

test("approved provenance survives squash ancestry while new promotion still checks its source", (t) => {
  const f = fixture(t);
  assert.equal(f.promote().status, 0);
  f.git(["checkout", "--orphan", "squashed-main"]);
  f.git(["add", "implementation.txt", "docs/evidence"]);
  f.git(["commit", "-qm", "squashed implementation and approved evidence"]);
  assert.equal(f.run(gate).status, 0);
  assert.equal(f.run(gate, ["--staged"]).status, 0);
  assert.notEqual(f.promote().status, 0);
});

test("review captures with common journey names stay isolated by ownership path", () => {
  const unlock = captureShotsDirectory(
    "work/evidence/unlock/pages/web/journey.json",
  );
  const share = captureShotsDirectory(
    "work/evidence/share/pages/web/journey.json",
  );
  assert.notEqual(unlock, share);
  assert.equal(
    unlock,
    captureShotsDirectory(
      resolve("work/evidence/unlock/pages/web/journey.json"),
    ),
  );
});

test("JSON approval and inventory fields reject numbers and objects without string coercion", () => {
  for (const invalid of [42, true, null, [], {}, { toString: "reviewer" }]) {
    for (const field of ["by", "reference"]) {
      const files = payload();
      const manifest = JSON.parse(files.get("manifest.json"));
      manifest.approval[field] = invalid;
      files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
      assert.throws(
        () => validateSlot(slot, files),
        /approval by and reference/u,
      );
    }
    const files = payload();
    const manifest = JSON.parse(files.get("manifest.json"));
    manifest.files[0].path = invalid;
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    assert.throws(() => validateSlot(slot, files), /invalid inventory entry/u);
  }
});
