import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  coverageViolations,
  sha256,
  sourceArea,
} from "../lib/exposure-coverage.mjs";
import { LOCAL_VAULT_CONTROLS } from "../lib/exposure-local-vault.mjs";
import {
  NATIVE_PROVIDER_CONTRACT,
  NATIVE_PROVIDER_CONTROLS,
} from "../lib/exposure-native-provider.mjs";
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

const ID = "native-provider-custody";
const lib = "packages/app-core/src/lib/";
const runtime = "apps/pages/src/modules/connectors.external/";
const baseline = parsePolicy(
  readFileSync(new URL(`../../${POLICY}`, import.meta.url)),
);
const matrix = () => structuredClone(baseline);
const row = (value) => value.surfaces.find((surface) => surface.id === ID);
const rules = (value) =>
  exposureViolations(validatePolicy(value)).map((issue) => issue.rule);

test("native provider custody is separate advisory device-owner publication policy", () => {
  const value = matrix();
  for (const field of [
    "kind",
    "area",
    "flow",
    "observer",
    "verification",
    "enforcement",
  ])
    assert.equal(row(value)[field], NATIVE_PROVIDER_CONTRACT[field], field);
  assert.deepEqual(row(value).guarantees, []);
  assert.deepEqual(row(value).controls, [...NATIVE_PROVIDER_CONTROLS]);
  assert.deepEqual(row(value).artifacts, [
    "ciphertext",
    "payload-key",
    "raw-secret",
  ]);
  assert.deepEqual(rules(value), []);
});

for (const control of NATIVE_PROVIDER_CONTROLS) {
  test(`native provider publication cannot omit ${control}`, () => {
    const value = matrix();
    row(value).controls = row(value).controls.filter(
      (item) => item !== control,
    );
    assert.ok(rules(value).includes("EM-NATIVE-PROVIDER-CUSTODY"));
    assert.ok(!rules(value).includes("EM-LOCAL-VAULT-CUSTODY"));
  });
}

for (const [field, values] of [
  ["kind", ["artifact", "policy", "online"]],
  ["area", ["local-vault-activation", "bitwarden", "portable-drop"]],
  ["flow", ["local-vault-activation", "bitwarden-import"]],
  ["observer", ["public", "authenticated", "authorized-recipient"]],
  ["verification", ["none", "server", "signature"]],
  ["enforcement", ["none", "authoritative"]],
]) {
  for (const next of values) {
    test(`native provider custody cannot relabel ${field} as ${next}`, () => {
      const value = matrix();
      row(value)[field] = next;
      assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
    });
  }
}

for (const guarantee of ["single-use", "expiry", "revocation"]) {
  test(`native provider custody cannot promise global ${guarantee}`, () => {
    const value = matrix();
    row(value).guarantees = [guarantee];
    assert.throws(() => validatePolicy(value), /guarantee limits/u);
    row(value).enforcement = "authoritative";
    assert.throws(() => validatePolicy(value), /EM-SCHEMA: required/u);
  });
}

for (const artifact of NATIVE_PROVIDER_CONTRACT.artifacts) {
  test(`native provider custody cannot hide ${artifact}`, () => {
    const value = matrix();
    row(value).artifacts = row(value).artifacts.filter(
      (item) => item !== artifact,
    );
    assert.throws(() => validatePolicy(value), /required artifact/u);
  });
}

test("native provider custody cannot be removed or renamed", () => {
  for (const rename of [false, true]) {
    const value = matrix();
    if (rename) row(value).id = "renamed-provider-boundary";
    else value.surfaces = value.surfaces.filter((item) => item.id !== ID);
    assert.throws(
      () => validatePolicy(value),
      /required boundary native-provider-custody/u,
    );
  }
});

test("unreviewed custody cannot borrow the native provider contract", () => {
  const value = matrix();
  value.surfaces.push({
    ...structuredClone(row(value)),
    id: "unreviewed-provider-custody",
    flow: "unreviewed-provider-custody",
  });
  assert.ok(rules(value).includes("EM-CUSTODY-CONTRACT"));
});

test("native provider and local vault controls cannot substitute for each other", () => {
  const value = matrix();
  row(value).controls = [...LOCAL_VAULT_CONTROLS];
  assert.ok(rules(value).includes("EM-NATIVE-PROVIDER-CUSTODY"));
  const local = value.surfaces.find(
    (surface) => surface.id === "local-vault-activation",
  );
  local.controls = [...NATIVE_PROVIDER_CONTROLS];
  assert.ok(rules(value).includes("EM-LOCAL-VAULT-CUSTODY"));
});

test("every native source and real regression belongs to the native surface itself", () => {
  for (const role of ["implementation", "regressions"]) {
    for (const path of NATIVE_PROVIDER_CONTRACT[role]) {
      const value = matrix();
      row(value)[role] = row(value)[role].filter((item) => item !== path);
      value.surfaces
        .find((surface) => surface.id === "local-vault-activation")
        [role].push(path);
      const snapshot = {
        paths: () => [],
        mode: () => "100644",
        read: () => Buffer.alloc(0),
      };
      assert.ok(
        coverageViolations(value, snapshot).includes(
          `EM-BINDING: ${ID} is missing its ${role} binding ${path}`,
        ),
        `${role}: ${path}`,
      );
    }
  }
});

const futureSources = [
  `${lib}native-key-result.ts`,
  `${lib}native-key-result.tsx`,
  `${lib}native-key/decode.ts`,
  `${lib}native-bitwarden-vault/decrypt.ts`,
  `${lib}native-bitwarden-vault/decrypt.tsx`,
  `${lib}native-bitwarden-sm-cache.ts`,
  `${lib}native-tailscale-token/publish.ts`,
  `${lib}native-tailscale-token/publish.tsx`,
  `${lib}native-bridge-owner.ts`,
  `${lib}connector-bridge-client/reply.ts`,
  `${lib}connector-bridge-client/reply.tsx`,
  `${lib}native-connector-transport/owner.ts`,
  `${lib}native-authorization-transport/check.ts`,
  `${lib}device-connector-records/commit.ts`,
  `${runtime}native-api-runtime-result.ts`,
  `${runtime}native-api-runtime-result.tsx`,
  `${runtime}native-runtime/authority.ts`,
  `${runtime}bridge-runtime/request.ts`,
  `${lib}native-api-requests/dispatch.tsx`,
  `${lib}native-api-operation-output.ts`,
  `${lib}native-api-resource/publish.tsx`,
  `${lib}native-oauth-resource-result.tsx`,
  `${lib}native-oauth-resource-driver/finish.ts`,
  `${lib}native-oauth-client-config/owner.tsx`,
  `${lib}native-oauth-commit/guard.ts`,
  `${lib}vault-credential-custody/current.tsx`,
  `${lib}secret-backends/runtime-owners/release.ts`,
  "packages/sdk-browser/src/pkce-verifier.ts",
  `${runtime}native-oauth-resource-runtime/owner.tsx`,
];

test("bounded native discovery follows named helpers without reclassifying existing vault support", () => {
  for (const path of futureSources) assert.equal(sourceArea(path), ID, path);
  assert.equal(sourceArea(`${lib}kv.ts`), "local-vault-activation");
  assert.equal(sourceArea(`${lib}__tests__/web-locks-double.ts`), undefined);
  for (const path of [
    `${lib}native-keynote.ts`,
    `${lib}native-tailscalex.ts`,
    `${lib}connector-bridgeway.ts`,
    `${lib}native-github-helper.ts`,
    `${lib}native-key-future.test.ts`,
    `${lib}native-bitwarden-vault/check.spec.ts`,
    `${lib}native-bitwarden-vault/check.spec.tsx`,
    `${lib}native-api-resourceful.ts`,
    `${lib}native-oauth-resourceful.ts`,
    `${lib}native-oauth-client-configuration.ts`,
    `${lib}native-api-requests/read.test.tsx`,
  ])
    assert.equal(sourceArea(path), undefined, path);
});

test("a saved helper hash and artifact row cannot borrow native custody classification", () => {
  const value = matrix();
  const path = futureSources[0];
  value.sources[path] = sha256(Buffer.alloc(0));
  value.surfaces.push({
    ...structuredClone(row(value)),
    id: "provider-result-bookkeeping",
    flow: "provider-result-bookkeeping",
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

test("actual native provider implementations and regressions reject unreviewed drift", (t) => {
  const f = gateFixture(t);
  assertClean(f.run());
  for (const path of [
    `${lib}native-key-kit.ts`,
    `${lib}native-key-driver.ts`,
    `${lib}native-key-http.ts`,
    `${lib}native-key-state.ts`,
    `${lib}native-connector-transport.ts`,
    `${lib}native-connector-store.ts`,
    `${lib}device-connector-records.ts`,
    `${lib}native-bitwarden-crypto.ts`,
    `${lib}native-bitwarden-vault-api.ts`,
    `${lib}native-tailscale-api.ts`,
    `${lib}native-bridge.ts`,
    `${lib}connector-bridge-client.ts`,
    `${runtime}native-api-runtime.ts`,
    `${runtime}native-runtime.ts`,
    `${lib}native-key-lifetime.test.ts`,
    "apps/pages/scripts/lib/native-browser-auth-field-contract.test.mjs",
    `${lib}native-api-operations.ts`,
    `${lib}connect-provider-auth-schema.ts`,
    `${lib}connect-provider-auth.test.ts`,
    `${lib}native-api-fingerprint.test.ts`,
    `${lib}native-api-resource.ts`,
    `${lib}native-api-resources.ts`,
    `${lib}native-api-operations.test-support.ts`,
    `${lib}native-oauth-resource.ts`,
    `${lib}native-oauth-resource-driver.ts`,
    `${lib}native-oauth-client-config.ts`,
    `${lib}native-oauth-client.test-support.ts`,
    `${lib}native-s3-backup.test-support.ts`,
    `${lib}native-provider-lifetime.test.ts`,
    `${runtime}native-oauth-resource-runtime.ts`,
    "packages/sdk-browser/src/pkce.ts",
  ]) {
    f.write(path, `${f.read(path)}\n// deliberate unreviewed drift\n`);
    assertBlocked(f.run(), /EM-DRIFT/u);
    f.restore(path);
  }
});

for (const path of [
  futureSources[0],
  `${lib}native-api-requests/dispatch.tsx`,
  `${lib}native-oauth-resource-result.tsx`,
]) {
  test(`new native helper ${path} is classified in every source snapshot`, (t) => {
    const f = gateFixture(t);
    f.write(path, "export const futureResult = () => {};\n");
    assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
    f.git(["add", path]);
    assertBlocked(
      f.run(["--staged"]),
      /EM-COVERAGE: unclassified protected source/u,
    );
    const head = f.commit("unclassified native helper");
    assertBlocked(
      f.run(["--ref", head]),
      /EM-COVERAGE: unclassified protected source/u,
    );
    assertBlocked(
      f.run(["--push-refs"], {
        input: `refs/heads/future ${head} refs/heads/future ${"0".repeat(40)}\n`,
      }),
      /EM-COVERAGE: unclassified protected source/u,
    );
    const value = matrix();
    value.sources[path] = sha256(Buffer.from(f.read(path)));
    assert.throws(() => validatePolicy(value), /unbound or invalid source/u);
  });
}

test("the native contract helper participates in index and ref checker equality", (t) => {
  const f = gateFixture(t);
  const path = "scripts/lib/exposure-native-provider.mjs";
  assert.ok(CHECKER_SOURCES.includes(path));
  f.write(path, `${f.read(path)}\n// unstaged checker drift\n`);
  for (const args of [["--staged"], ["--ref", f.head]])
    assertBlocked(f.run(args), /EM-CHECKER-SNAPSHOT/u);
  assertBlocked(
    f.run(["--push-refs"], {
      input: `refs/heads/main ${f.head} refs/heads/main ${"0".repeat(40)}\n`,
    }),
    /EM-CHECKER-SNAPSHOT/u,
  );
});
