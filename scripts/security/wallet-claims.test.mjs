import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  initializeWalletVerification,
  readWalletClaims,
  startWalletVerification,
} from "../wallet/lib/claims.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = "OPENSESAME_WALLET_RUN_ID";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wallet-claims-"));
  const previous = process.env[RUN];
  delete process.env[RUN];
  t.after(() => {
    if (previous === undefined) delete process.env[RUN];
    else process.env[RUN] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const seedPath = join(root, "spec/conformance/wallet-claims.json");
  mkdirSync(dirname(seedPath), { recursive: true });
  writeFileSync(
    seedPath,
    JSON.stringify({ claims: { A: { status: "specified" } } }),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("config", "user.name", "Wallet tests");
  git("config", "user.email", "wallet@example.test");
  git("add", "spec");
  git("commit", "-qm", "obligations");
  const scratch = join(
    root,
    "work/evidence/wallet/wallet/cross-platform/claims.json",
  );
  mkdirSync(dirname(scratch), { recursive: true });
  const markPassed = () => {
    const claims = readWalletClaims(root);
    claims.claims.A.status = "local_execution_verified";
    writeFileSync(scratch, JSON.stringify(claims));
  };
  return { root, scratch, seedPath, git, markPassed };
}

test("a new verification resets old successful claims even at the same HEAD and seed", (t) => {
  const f = fixture(t);
  const prior = startWalletVerification(f.root);
  f.markPassed();
  const next = startWalletVerification(f.root);
  assert.equal(next.claims.A.status, "specified");
  assert.notEqual(next.verificationRun.id, prior.verificationRun.id);
});

test("standalone initialization never reuses an old scratch pass", (t) => {
  const f = fixture(t);
  startWalletVerification(f.root);
  f.markPassed();
  delete process.env[RUN];
  assert.equal(
    initializeWalletVerification(f.root).claims.A.status,
    "specified",
  );
});

test("child suites preserve updates only within the matching verification run", (t) => {
  const f = fixture(t);
  const started = startWalletVerification(f.root);
  f.markPassed();
  const continued = initializeWalletVerification(f.root);
  assert.equal(continued.claims.A.status, "local_execution_verified");
  assert.equal(continued.verificationRun.id, started.verificationRun.id);
  process.env[RUN] = "another-run";
  assert.throws(() => readWalletClaims(f.root), /stale wallet claims/u);
});

test("claims refuse a changed source commit or modified obligation seed", (t) => {
  const f = fixture(t);
  startWalletVerification(f.root);
  f.markPassed();
  f.git("commit", "--allow-empty", "-qm", "new implementation");
  assert.throws(() => readWalletClaims(f.root), /stale wallet claims/u);
  startWalletVerification(f.root);
  writeFileSync(
    f.seedPath,
    JSON.stringify({
      claims: { A: { status: "specified" }, B: { status: "specified" } },
    }),
  );
  assert.throws(() => readWalletClaims(f.root), /stale wallet claims/u);
});

test("actual verify CLI resets claims before dry-run and mainnet refusal", (t) => {
  const f = fixture(t);
  cpSync(join(repo, "scripts/wallet"), join(f.root, "scripts/wallet"), {
    recursive: true,
  });
  for (const [args, extra, exit] of [
    [["--dry-run"], {}, 1],
    [[], { CHAIN_ID: "1" }, 2],
  ]) {
    startWalletVerification(f.root);
    f.markPassed();
    const result = spawnSync(
      process.execPath,
      [join(f.root, "scripts/wallet/verify.mjs"), ...args],
      {
        cwd: f.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CHAIN_ID: "31337", ...extra },
      },
    );
    assert.equal(result.status, exit, result.stderr);
    const reset = JSON.parse(readFileSync(f.scratch, "utf8"));
    assert.equal(reset.claims.A.status, "specified");
    const report = JSON.parse(
      readFileSync(join(dirname(f.scratch), "last-run.json"), "utf8"),
    );
    assert.equal(report.ok, false);
    assert.equal(report.verificationRunId, reset.verificationRun.id);
  }
});

test("actual standalone adapter CLI clears unrelated old passes", (t) => {
  const f = fixture(t);
  cpSync(join(repo, "scripts/wallet"), join(f.root, "scripts/wallet"), {
    recursive: true,
  });
  startWalletVerification(f.root);
  f.markPassed();
  const result = spawnSync(
    process.execPath,
    [join(f.root, "scripts/wallet/blocked-adapters.mjs")],
    {
      cwd: f.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, [RUN]: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const claims = JSON.parse(readFileSync(f.scratch, "utf8"));
  assert.equal(claims.claims.A.status, "specified");
});
