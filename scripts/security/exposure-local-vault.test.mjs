import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  coverageViolations,
  sha256,
  sourceArea,
} from "../lib/exposure-coverage.mjs";
import {
  LOCAL_VAULT_CONTRACT,
  LOCAL_VAULT_CONTROLS,
} from "../lib/exposure-local-vault.mjs";
import {
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";
import {
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";
import { CHECKER_SOURCES } from "./exposure-matrix-gate.mjs";

const ID = "local-vault-activation";
const lib = "packages/app-core/src/lib/";
const vault = `${lib}vault/`;
const baseline = parsePolicy(
  readFileSync(new URL(`../../${POLICY}`, import.meta.url)),
);
const matrix = () => structuredClone(baseline);
const row = (value) => value.surfaces.find((surface) => surface.id === ID);
const rules = (value) =>
  exposureViolations(validatePolicy(value)).map((issue) => issue.rule);

test("local activation is reviewed device-owner process custody with no global claims", () => {
  const value = matrix();
  const local = row(value);
  for (const field of [
    "kind",
    "area",
    "flow",
    "observer",
    "verification",
    "enforcement",
  ])
    assert.equal(local[field], LOCAL_VAULT_CONTRACT[field], field);
  assert.deepEqual(local.guarantees, []);
  assert.deepEqual(local.controls, [...LOCAL_VAULT_CONTROLS]);
  assert.deepEqual(rules(value), []);
});

for (const control of LOCAL_VAULT_CONTROLS) {
  test(`local activation cannot omit ${control}`, () => {
    const value = matrix();
    row(value).controls = row(value).controls.filter(
      (item) => item !== control,
    );
    assert.ok(rules(value).includes("EM-LOCAL-VAULT-CUSTODY"));
    assert.ok(!rules(value).includes("EM-IMPORT-CUSTODY"));
  });
}

for (const [field, values] of [
  ["kind", ["policy", "artifact", "online"]],
  [
    "observer",
    ["public", "authenticated", "authorized-recipient", "link-holder"],
  ],
  ["area", ["bitwarden", "portable-drop"]],
  ["flow", ["bitwarden-import", "portable-secret-drop"]],
  ["verification", ["none", "server", "signature", "code-aead"]],
  ["enforcement", ["none", "authoritative"]],
]) {
  for (const next of values) {
    test(`local activation cannot relabel ${field} as ${next}`, () => {
      const value = matrix();
      row(value)[field] = next;
      assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
    });
  }
}

for (const guarantee of ["single-use", "expiry", "revocation"]) {
  test(`local activation cannot claim global ${guarantee}`, () => {
    const value = matrix();
    row(value).guarantees = [guarantee];
    assert.throws(() => validatePolicy(value), /guarantee limits/u);
    row(value).enforcement = "authoritative";
    assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
  });
}

for (const artifact of LOCAL_VAULT_CONTRACT.artifacts) {
  test(`local custody cannot hide its ${artifact}`, () => {
    const value = matrix();
    row(value).artifacts = row(value).artifacts.filter(
      (item) => item !== artifact,
    );
    assert.throws(() => validatePolicy(value), /required artifact/u);
  });
}

test("local activation cannot be removed or renamed", () => {
  for (const rename of [false, true]) {
    const value = matrix();
    if (rename) row(value).id = "renamed-local-unlock";
    else value.surfaces = value.surfaces.filter((surface) => surface.id !== ID);
    assert.throws(
      () => validatePolicy(value),
      /required boundary local-vault-activation/u,
    );
  }
});

for (const template of ["local-vault-activation", "bitwarden-import"]) {
  test(`a new custody boundary cannot borrow ${template}'s classification`, () => {
    const value = matrix();
    value.surfaces.push({
      ...structuredClone(
        value.surfaces.find((surface) => surface.id === template),
      ),
      id: "unreviewed-custody",
      flow: "unreviewed-custody",
    });
    assert.ok(rules(value).includes("EM-CUSTODY-CONTRACT"));
  });
}

test("local controls cannot substitute for the existing import controls", () => {
  const value = matrix();
  value.surfaces.find((surface) => surface.id === "bitwarden-import").controls =
    [...LOCAL_VAULT_CONTROLS];
  assert.ok(rules(value).includes("EM-IMPORT-CUSTODY"));
});

test("every named local source and behavior regression is mandatory on its own surface", () => {
  for (const role of ["implementation", "regressions"]) {
    for (const path of LOCAL_VAULT_CONTRACT[role]) {
      const value = matrix();
      row(value)[role] = row(value)[role].filter((item) => item !== path);
      value.surfaces
        .find((surface) => surface.id === "bitwarden-import")
        [role].push(path);
      const snapshot = {
        paths: () => [],
        mode: () => "100644",
        read: () => Buffer.alloc(0),
      };
      assert.ok(
        coverageViolations(value, snapshot).some(
          (issue) =>
            issue ===
            `EM-BINDING: ${ID} is missing its ${role} binding ${path}`,
        ),
        `${role}: ${path}`,
      );
    }
  }
});

const futureSources = [
  `${vault}store-unlock-contact.ts`,
  `${vault}store-primary/new-entry.ts`,
  `${vault}store-header-publication/write.ts`,
  `${vault}vault-shared-locks/admit.ts`,
  `${vault}unlock-factor-crypto/pin.ts`,
  `${vault}protection/session-guard/check.ts`,
  `${vault}authentication-storage/refresh.ts`,
  `${lib}local-iam-access/read.ts`,
  `${lib}local-passkey-authentication/verify.ts`,
  `${lib}trusted-unlock-policy.ts`,
  `${lib}vfs-operation-check/owner.ts`,
  `${lib}kv-entry-lifecycle/publish.ts`,
  `${lib}projects-session/cache.ts`,
  `${lib}secret-fs/install/guarded-write.ts`,
  `${lib}deadman/authentication/heartbeat.ts`,
  `${lib}deadman/state-publish.ts`,
  `${lib}deadman/fence/queue.ts`,
  `${lib}deadman/arm/commit.ts`,
  `${lib}vfs-sealed-index/revise.ts`,
  "packages/auth-upstream/src/passkey-verification/assertion.ts",
  "packages/sdk-browser/src/webauthn/assertion.ts",
];

test("bounded discovery follows named local entry, verification and persistence lanes", () => {
  for (const path of futureSources) assert.equal(sourceArea(path), ID, path);
  for (const path of [
    `${vault}store-unlock-future.test.ts`,
    `${lib}local-passkey-authentication/verify.spec.ts`,
    `${lib}unrelated-panel.ts`,
    "packages/auth-upstream/src/unrelated-verifier.ts",
    `${lib}deadman/package-format.ts`,
    `${lib}deadman/relay.ts`,
  ])
    assert.equal(sourceArea(path), undefined, path);
});

test("local activation helpers cannot borrow a new artifact row in the same area", () => {
  const value = matrix();
  const path = futureSources[0];
  value.sources[path] = sha256(Buffer.alloc(0));
  value.surfaces.push({
    ...structuredClone(row(value)),
    id: "local-helper-bookkeeping",
    flow: "local-helper-bookkeeping",
    kind: "artifact",
    artifacts: [],
    verification: "none",
    controls: [],
    implementation: [path],
  });
  assert.deepEqual(rules(value), []);
  const snapshot = {
    paths: () => [path],
    mode: () => "100644",
    read: () => Buffer.alloc(0),
  };
  assert.ok(
    coverageViolations(value, snapshot).some((issue) =>
      issue.startsWith(`EM-COVERAGE: unclassified protected source ${path};`),
    ),
  );
});

test("real local sources and regressions fail on source drift", (t) => {
  const f = gateFixture(t);
  assertClean(f.run());
  for (const path of [
    `${vault}store.ts`,
    `${vault}store-unlock-session.ts`,
    `${vault}store-operation-check.ts`,
    `${vault}vault-shared-locks.ts`,
    `${lib}local-iam-access.ts`,
    `${lib}local-passkey-authentication.ts`,
    `${lib}local-credentials.ts`,
    `${lib}trusted-unlock.ts`,
    `${lib}vfs.ts`,
    `${lib}kv.ts`,
    `${lib}projects-session.ts`,
    `${lib}vfs-sealed-index.ts`,
    `${lib}deadman/authentication.ts`,
    `${lib}deadman/fence.ts`,
    `${lib}deadman/state.ts`,
    `${lib}deadman/arm.ts`,
    "packages/auth-upstream/src/passkey-verification.ts",
    `${vault}store-unlock-races.fixture.ts`,
    `${lib}local-authenticator.fixture.ts`,
    `${lib}secret-fs/install.ts`,
    `${lib}trusted-unlock-access-commit.test.ts`,
    `${lib}trusted-unlock-access-legacy.test.ts`,
    `${lib}vfs-guarded-commit.test.ts`,
    `${vault}store-unlock-deadman-lifetime.test.ts`,
    `${vault}store-unlock-registration-lifetime.test.ts`,
    `${lib}tailnet-sync/devices.fixture.ts`,
    `${lib}tailnet-sync/devices-lifecycle.test.ts`,
    "packages/app-core/src/browser/oidc/oidc.test-support.ts",
    "packages/app-core/src/browser/oidc/admission.test.ts",
    `${vault}store-unlock-trusted-custody.test.ts`,
    `${lib}trusted-unlock-access.test.ts`,
  ]) {
    f.write(path, `${f.read(path)}\n// deliberate unreviewed drift\n`);
    assertBlocked(f.run(), /EM-DRIFT/u);
    f.restore(path);
  }
});

test("new named helpers need classification even if somebody saves their hash", (t) => {
  const f = gateFixture(t);
  const path = futureSources[0];
  const bytes = "export const futureUnlock = () => {};\n";
  f.write(path, bytes);
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
  f.git(["add", path]);
  assertBlocked(
    f.run(["--staged"]),
    /EM-COVERAGE: unclassified protected source/u,
  );
  const value = matrix();
  value.sources[path] = sha256(Buffer.from(bytes));
  assert.throws(() => validatePolicy(value), /unbound or invalid source/u);
  f.write(POLICY, `${JSON.stringify(value, null, 2)}\n`);
  assertBlocked(f.run(), /EM-SCHEMA/u);
});

test("the new contract helper participates in checker snapshot equality", (t) => {
  const f = gateFixture(t);
  const path = "scripts/lib/exposure-local-vault.mjs";
  assert.ok(CHECKER_SOURCES.includes(path));
  f.write(path, `${f.read(path)}\n// unstaged checker drift\n`);
  assertBlocked(f.run(["--staged"]), /EM-CHECKER-SNAPSHOT/u);
});
