import assert from "node:assert/strict";
import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAIM,
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";
import { CHECKER_SOURCES } from "./exposure-matrix-gate.mjs";

const originalGuard =
  'claim.targetManifest.kind !== "secret-drop" && userCode === undefined';
const bypassGuard = "userCode === undefined";
function weakenClaim(f) {
  f.replace(CLAIM, originalGuard, bypassGuard);
}
function weakenPolicy(f) {
  const policy = JSON.parse(f.read(POLICY));
  policy.surfaces.find(
    (row) => row.id === "hosted-secret-drop",
  ).budget.storage = "process-local";
  f.write(POLICY, JSON.stringify(policy));
}

test("actual CLI accepts the reviewed working, staged and committed trees", (t) => {
  const f = gateFixture(t);
  for (const args of [[], ["--staged"], ["--ref", "HEAD"]]) {
    assertClean(f.run(args));
  }
});

test("an unstaged guard repair cannot mask an unsafe staged implementation", (t) => {
  const f = gateFixture(t);
  weakenClaim(f);
  f.git(["add", CLAIM]);
  f.restore(CLAIM);
  assertClean(f.run());
  assertBlocked(f.run(["--staged"]), /EM-DRIFT.*claim-presentation\.ts/s);
});

test("a staged repair is validated independently of an unsafe working guard", (t) => {
  const f = gateFixture(t);
  weakenClaim(f);
  f.git(["add", CLAIM]);
  f.restore(CLAIM);
  f.git(["add", CLAIM]);
  weakenClaim(f);
  assertClean(f.run(["--staged"]));
  assertBlocked(f.run(), /EM-DRIFT.*claim-presentation\.ts/s);
});

test("policy is loaded from the selected tree in both directions", (t) => {
  const f = gateFixture(t);
  weakenPolicy(f);
  f.git(["add", POLICY]);
  f.restore(POLICY);
  assertClean(f.run());
  assertBlocked(f.run(["--staged"]), /EM-GUESS-BUDGET/);
  f.git(["add", POLICY]);
  weakenPolicy(f);
  assertClean(f.run(["--staged"]));
  assertBlocked(f.run(), /EM-GUESS-BUDGET/);
});

test("all executing checker dependencies must match the selected tree", (t) => {
  const f = gateFixture(t);
  for (const path of CHECKER_SOURCES) {
    f.write(path, `${f.read(path)}\n// staged checker variant\n`);
    f.git(["add", path]);
    f.restore(path);
    assertBlocked(f.run(["--staged"]), /EM-CHECKER-SNAPSHOT/);
    f.git(["add", path]);
  }
  const path = CHECKER_SOURCES[0];
  chmodSync(f.path(path), 0o755);
  f.git(["add", path]);
  chmodSync(f.path(path), 0o644);
  assertBlocked(f.run(["--staged"]), /EM-CHECKER-SNAPSHOT/);
});

test("new protected files need classification even while untracked", (t) => {
  const f = gateFixture(t);
  const path = "packages/control-plane/src/routes/claim-new-exposure.ts";
  f.write(path, "export async function verifyCode() { return true; }\n");
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/);
  f.git(["add", path]);
  assertBlocked(
    f.run(["--staged"]),
    /EM-COVERAGE: unclassified protected source/,
  );
});

test("missing and staged-deleted reviewed files cannot borrow another tree's bytes", (t) => {
  const f = gateFixture(t);
  rmSync(f.path(CLAIM));
  assertBlocked(f.run(), /EM-SOURCE.*claim-presentation\.ts/s);
  assertClean(f.run(["--staged"]));
  f.git(["add", "-u", CLAIM]);
  assertBlocked(f.run(["--staged"]), /EM-SOURCE.*claim-presentation\.ts/s);
  const removed = f.commit("deleted reviewed implementation");
  assertBlocked(
    f.run(["--ref", removed]),
    /EM-SOURCE.*claim-presentation\.ts/s,
  );
});

test("symlink source modes are refused in working and staged trees", (t) => {
  const f = gateFixture(t);
  rmSync(f.path(CLAIM));
  symlinkSync("mfa.ts", f.path(CLAIM));
  assertBlocked(f.run(), /EM-SOURCE.*not a regular file/s);
  f.git(["add", CLAIM]);
  f.restore(CLAIM);
  assertClean(f.run());
  assertBlocked(f.run(["--staged"]), /EM-SOURCE.*not a regular file/s);
});

test("unresolved source stages fail the actual gate despite safe working bytes", (t) => {
  const f = gateFixture(t);
  const object = f.git(["rev-parse", `HEAD:${CLAIM}`]);
  f.git(["update-index", "--force-remove", CLAIM]);
  f.git(
    ["update-index", "--index-info"],
    `100644 ${object} 1\t${CLAIM}\n100644 ${object} 2\t${CLAIM}\n100644 ${object} 3\t${CLAIM}\n`,
  );
  assertClean(f.run());
  assertBlocked(f.run(["--staged"]), /EM-SOURCE.*Unresolved index path/s);
});

const mutations = [
  ["mandatory server guard", CLAIM, originalGuard, bypassGuard],
  [
    "archive parent no-follow admission removed",
    "crates/bitwarden-server/src/import/file_paths.rs",
    " | OFlags::NOFOLLOW",
    "",
  ],
  [
    "HTTP bytes retained before intake admission",
    "crates/provider-bitwarden/src/api/body.rs",
    "chunk.len() > limit.saturating_sub(body.len())",
    "false",
  ],
  [
    "credential origin admission disabled",
    "crates/provider-bitwarden/src/api/endpoints.rs",
    `if joined.origin() != base.origin()
        || !joined.username().is_empty()
        || joined.password().is_some()`,
    "if false",
  ],
  [
    "public JWK allowlist replaced with spread",
    "packages/oauth-provider/src/keys/dev-signing-key-provider.ts",
    "const published: SigningJwk = { kty: key.kty };",
    "const published: SigningJwk = { ...key };",
  ],
  [
    "atomic SQL admission counter reset",
    "crates/storage/src/est_source_budgets.rs",
    "DO UPDATE SET attempts = attempts + 1",
    "DO UPDATE SET attempts = 1",
  ],
  [
    "omitted bootstrap policy becomes optional",
    "crates/gateway/src/routes/est_server.rs",
    ".is_none_or(|config| config.require_bootstrap)",
    ".is_none_or(|_config| false)",
  ],
  [
    "guard exists only in a comment",
    CLAIM,
    `const attempts = await incrementSecurityCounter(
    ctx.stores.claimApprovalAttempts,
    claim.id,
  );`,
    `/* const attempts = await incrementSecurityCounter(
    ctx.stores.claimApprovalAttempts,
    claim.id,
  ); */ const attempts = 0;`,
  ],
];

for (const [name, path, before, after] of mutations) {
  test(`unchanged reviewed fingerprints reject ${name}`, (t) => {
    const f = gateFixture(t);
    const policyBefore = f.read(POLICY);
    f.replace(path, before, after);
    assertBlocked(f.run(), /EM-DRIFT: reviewed implementation changed/);
    assert.equal(
      f.read(POLICY),
      policyBefore,
      "the checker must never auto re-pin",
    );
  });
}

test("policy omissions cannot remove source or core-surface coverage", (t) => {
  const f = gateFixture(t);
  const missingHash = JSON.parse(f.read(POLICY));
  delete missingHash.sources[CLAIM];
  f.write(POLICY, JSON.stringify(missingHash));
  assertBlocked(f.run(), /EM-SCHEMA: missing source fingerprint/);
  for (const row of missingHash.surfaces) {
    row.implementation = row.implementation.filter((path) => path !== CLAIM);
    row.regressions = row.regressions.filter((path) => path !== CLAIM);
  }
  f.write(POLICY, JSON.stringify(missingHash));
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/);
  f.restore(POLICY);
  const omittedSurface = JSON.parse(f.read(POLICY));
  omittedSurface.surfaces = omittedSurface.surfaces.filter(
    (row) => row.id !== "account-totp",
  );
  f.write(POLICY, JSON.stringify(omittedSurface));
  assertBlocked(f.run(), /EM-SCHEMA: required boundary account-totp/);
});

test("there is no command that automatically blesses changed implementations", (t) => {
  const f = gateFixture(t);
  weakenClaim(f);
  const policyBefore = f.read(POLICY);
  for (const flag of ["--update", "--accept-new-debt", "--refresh"]) {
    assertBlocked(f.run([flag]), /usage: exposure-matrix-gate/);
  }
  assert.equal(f.read(POLICY), policyBefore);
});

test("a real pre-push hook checks actual other refs even when optional checks are off", (t) => {
  const f = gateFixture(t);
  const remote = join(f.container, "remote.git");
  f.git(["init", "--bare", "-q", remote]);
  f.git(["remote", "add", "origin", remote]);
  f.git(["config", "core.hooksPath", ".githooks"]);
  const env = { OPENSESAME_PREPUSH: "off" };
  const safe = f.command(
    ["push", "--quiet", "origin", "HEAD:refs/heads/safe"],
    { env },
  );
  assert.equal(safe.status, 0, safe.stderr);
  assert.match(`${safe.stdout}\n${safe.stderr}`, /exposure matrix: CLEAN/);
  assert.equal(
    f.git(["--git-dir", remote, "rev-parse", "refs/heads/safe"]),
    f.head,
  );
  f.git(["checkout", "-qb", "unsafe"]);
  weakenClaim(f);
  f.commit("unsafe other branch");
  f.git(["checkout", "-q", "main"]);
  assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
  assertClean(f.run());
  const denied = f.command(
    [
      "push",
      "--quiet",
      "origin",
      "HEAD:refs/heads/another-safe",
      "refs/heads/unsafe:refs/heads/unsafe",
    ],
    { env },
  );
  assert.notEqual(denied.status, 0, denied.stdout);
  assert.match(
    `${denied.stdout}\n${denied.stderr}`,
    /EM-DRIFT.*claim-presentation\.ts/s,
  );
  for (const ref of ["refs/heads/unsafe", "refs/heads/another-safe"]) {
    assert.notEqual(
      f.command(["--git-dir", remote, "show-ref", "--verify", "--quiet", ref])
        .status,
      0,
    );
  }
});
