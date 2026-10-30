import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { sourceArea } from "../lib/exposure-coverage.mjs";
import {
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";

const nestedSources = [
  ["bitwarden", "crates/bitwarden-server/src/models/token/session.rs"],
  ["bitwarden", "crates/bitwarden-server/src/routes/identity/token.rs"],
  ["bitwarden", "crates/provider-bitwarden/src/api/transport/reader.rs"],
  ["est-enrollment", "crates/gateway/src/routes/est/certificates/issue.rs"],
  ["est-enrollment", "crates/gateway/src/routes/est_server/bootstrap/auth.rs"],
  ["est-enrollment", "crates/gateway/src/routes/est_enrollment/authorize.rs"],
  ["host-admission", "crates/gateway/src/transport/tls/client/verify.rs"],
];

function assertUnclassified(result, path) {
  assertBlocked(result, /EM-COVERAGE: unclassified protected source/u);
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes(
      `EM-COVERAGE: unclassified protected source ${path};`,
    ),
    path,
  );
}

test("protected Rust discovery follows nested modules at arbitrary depths", () => {
  for (const [area, path] of nestedSources) {
    assert.equal(sourceArea(path), area, path);
  }
  for (const path of [
    "crates/bitwarden-server/src/lib.rs",
    "crates/bitwarden-server/src/routes/mod.rs",
    "crates/gateway/src/routes/est_server.rs",
    "crates/gateway/src/transport/mod.rs",
  ]) {
    assert.ok(sourceArea(path), path);
  }
});

test("recursive discovery excludes tests and unrelated sources without hiding production modules", () => {
  for (const path of [
    "crates/bitwarden-server/src/routes/identity/token_tests.rs",
    "crates/bitwarden-server/src/routes/identity/token_test.rs",
    "crates/bitwarden-server/src/models/tests.rs",
    "crates/provider-bitwarden/src/api/body_tests_bound.rs",
    "crates/bitwarden-server/src/models/tests/token.rs",
    "crates/bitwarden-server/src/fixtures/models/token.rs",
    "crates/bitwarden-server/src/test_support/token.rs",
    "crates/bitwarden-server/src/test-support/token.rs",
    "crates/gateway/src/routes/est_server/tests/authorize.rs",
    "crates/gateway/src/transport/tls/fixtures/server.rs",
    "crates/gateway/src/transport/tls/client.test.ts",
    "crates/bitwarden-server/src/routes/token.rs.bak",
    "crates/bitwarden-server-other/src/routes/token.rs",
    "crates/bitwarden-server/examples/routes/token.rs",
    "crates/gateway/src/routes/health.rs",
    "crates/gateway/src/transports/tls/client.rs",
  ]) {
    assert.equal(sourceArea(path), undefined, path);
  }
  assert.equal(
    sourceArea("crates/bitwarden-server/src/models/contest.rs"),
    "bitwarden",
  );
  assert.equal(
    sourceArea("crates/gateway/src/transport/testing/client.rs"),
    "host-admission",
  );
});

for (const [area, path] of nestedSources) {
  test(`actual CLI requires explicit review of a new nested ${area} source: ${path}`, (t) => {
    const f = gateFixture(t);
    assertClean(f.run());
    f.write(path, "pub fn new_authentication_surface() -> bool { true }\n");
    assertUnclassified(f.run(), path);
    assertClean(f.run(["--staged"]));
    f.git(["add", path]);
    assertUnclassified(f.run(["--staged"]), path);
    rmSync(f.path(path));
    assertClean(f.run());
    assertUnclassified(f.run(["--staged"]), path);
    f.git(["reset", "-q", "HEAD", "--", path]);
    assertClean(f.run(["--staged"]));
  });
}
