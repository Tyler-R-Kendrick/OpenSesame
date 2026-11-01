import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readTree, sha256, validateSlot } from "../lib/evidence-policy.mjs";

// The approval half of the evidence contract (docs/evidence/README.md): the gate
// (through validateSlot) and the promoter refuse an approval nobody gave.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const promotion = join(root, "scripts/dev/promote-evidence.mjs");
const gate = join(root, "scripts/quality/evidence-gate.mjs");
const slot = "unlock/pages/web";
const reviewer = "Tyler-R-Kendrick";
const review =
  "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#pullrequestreview-3412345678";

/** A persisted slot whose manifest records this approval, inventory exact. */
function approvedBy(by, reference) {
  const files = new Map([
    ["README.md", Buffer.from("# Current unlock\n")],
    ["desktop.png", Buffer.from("reviewed capture")],
  ]);
  const manifest = {
    version: 1,
    status: "approved",
    sourceCommit: "a".repeat(40),
    approval: { by, reference },
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
  };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return files;
}

/** A repository with one implementation commit and an approved-only candidate. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "evidence-approval-test-"));
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
  const candidate = join(directory, "work", "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, "README.md"), "# Approved current state\n");
  writeFileSync(join(candidate, "desktop.png"), "approved current capture");
  const run = (script, args = []) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const promote = (by = reviewer, reference = review) =>
    run(promotion, [
      slot,
      candidate,
      "--source",
      source,
      "--approved-by",
      by,
      "--approval-ref",
      reference,
    ]);
  return { directory, promote, gate: () => run(gate) };
}

test("approval names a reviewer's GitHub login, never a placeholder", () => {
  // The shape 6f2136a30 promoted: an approval nobody gave.
  assert.throws(
    () =>
      validateSlot(
        slot,
        approvedBy(
          "pending review",
          "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045 (review pending)",
        ),
      ),
    /approval/u,
  );
  for (const placeholder of [
    "pending review",
    "Pending Review",
    "PENDING",
    "pending",
    "pending-review",
    "Pending_Review",
    "TBD",
    "tba",
    "ToDo",
    "None",
    "N/A",
    "na",
    "Unknown",
    "null",
    "undefined",
    "reviewer",
    "Approver",
  ]) {
    assert.throws(
      () => validateSlot(slot, approvedBy(placeholder, review)),
      /approval\.by/u,
      placeholder,
    );
  }
  for (const notALogin of [
    "-leading",
    "trailing-",
    "double--hyphen",
    "has space",
    "under_score",
    "a".repeat(40),
    "<reviewer>",
    "@Tyler-R-Kendrick",
  ]) {
    assert.throws(
      () => validateSlot(slot, approvedBy(notALogin, review)),
      /approval\.by/u,
      notALogin,
    );
  }
  for (const login of [
    "Tyler-R-Kendrick",
    "octocat",
    "a",
    "a1-b2",
    "x".repeat(39),
  ])
    assert.equal(
      validateSlot(slot, approvedBy(login, review)).approval.by,
      login,
    );
});

test("approval reference links a pull request, review or comment of this repository", () => {
  for (const reference of [
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#pullrequestreview-3412345678",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#issuecomment-4366962002",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#discussion_r2462234567",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045/files#r2462234567",
    "https://github.com/OpenSesame-Labs/OpenSesame/issues/2001#issuecomment-4366962002",
    "https://github.com/tyler-r-kendrick/opensesame/pull/7",
  ])
    assert.equal(
      validateSlot(slot, approvedBy(reviewer, reference)).approval.reference,
      reference,
    );
  for (const reference of [
    "https://review.example/42",
    "https://gitlab.com/OpenSesame-Labs/OpenSesame/-/merge_requests/1",
    "http://github.com/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://github.com.evil.example/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://evil.example/github.com/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://user@github.com/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://github.com:8443/OpenSesame-Labs/OpenSesame/pull/2045",
    "https://github.com/someone-else/OpenSesame/pull/2045",
    "https://github.com/OpenSesame-Labs/OpenSesame-fork/pull/2045",
    "https://github.com/OpenSesame-Labs/OpenSesame",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/0",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045?approved=1",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045#anything",
    "https://github.com/OpenSesame-Labs/OpenSesame/issues/2001",
    "https://github.com/OpenSesame-Labs/OpenSesame/tree/main/docs/evidence",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045 (review pending)",
    "pending review",
  ])
    assert.throws(
      () => validateSlot(slot, approvedBy(reviewer, reference)),
      /approval\.reference/u,
      reference,
    );
});

test("promotion refuses a placeholder approval and writes nothing", (t) => {
  const f = fixture(t);
  const destination = join(f.directory, "docs/evidence", slot);
  const refused = f.promote(
    "pending review",
    "https://github.com/OpenSesame-Labs/OpenSesame/pull/2045 (review pending)",
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /approval/u);
  assert.throws(() => readTree(destination));
  const elsewhere = f.promote(reviewer, "https://review.example/42");
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stderr, /approval\.reference/u);
  assert.throws(() => readTree(destination));
  const accepted = f.promote();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(f.gate().status, 0);
});
