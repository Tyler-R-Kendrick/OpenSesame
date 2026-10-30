import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_CONTRACTS } from "../lib/exposure-contracts.mjs";
import { sourceArea } from "../lib/exposure-coverage.mjs";
import {
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";

const CLAIMS = "packages/app-core/src/lib/claims/";
const ROUTE = "apps/pages/src/modules/identity.ceremonies/ClaimRoute.tsx";
const OPEN = `${CLAIMS}drop-open.ts`;
const LINK = `${CLAIMS}link.ts`;
const LEAK_CHECK =
  'const leaked = ["token", "key", "pkt"].some((name) => queried.has(name));';

test("drop dispatch and the bounded key-custody helpers stay in discovery", () => {
  for (const path of [
    OPEN,
    `${CLAIMS}arrival.ts`,
    LINK,
    `${CLAIMS}stash.ts`,
    `${CLAIMS}route-model.ts`,
    `${CLAIMS}drop-open/nested/release.ts`,
    `${CLAIMS}drop-open-helper.ts`,
    `${CLAIMS}arrival-helper.ts`,
    "packages/app-core/package.json",
    "packages/ceremony-kit/package.json",
    "packages/ceremony-kit/src/index.ts",
    "packages/ceremony-kit/src/links.ts",
    "packages/ceremony-kit/src/claim-link.ts",
    "packages/ceremony-kit/src/claim-stash.ts",
    "packages/ceremony-kit/src/claim-link/nested/read.ts",
    "packages/ceremony-kit/src/claim-link-helper.ts",
    "packages/vault-core/package.json",
    "packages/vault-core/src/index.ts",
    "packages/vault-core/src/crypto.ts",
    "packages/vault-core/src/bytes.ts",
    "packages/vault-core/src/drop-format.ts",
    "packages/vault-core/src/drop-format/nested/open.ts",
    "packages/vault-core/src/crypto/nested/entropy.ts",
    "packages/vault-core/src/bytes/nested/decode.ts",
    "packages/vault-core/src/drop-format-helper.ts",
  ]) {
    assert.equal(sourceArea(path), "portable-drop", path);
  }
  assert.equal(sourceArea(ROUTE), "share-lifecycle");
  assert.equal(
    sourceArea(
      "apps/pages/src/modules/identity.ceremonies/ClaimRoute-helper.tsx",
    ),
    "share-lifecycle",
  );
  assert.equal(
    sourceArea(
      "apps/pages/src/modules/identity.ceremonies/ClaimDifferentLink.tsx",
    ),
    "share-lifecycle",
  );
  assert.equal(sourceArea(`${CLAIMS}link.test.ts`), undefined);
  assert.equal(sourceArea(`${CLAIMS}unrelated-ceremony.ts`), undefined);
  assert.equal(
    sourceArea("packages/vault-core/src/unrelated-format.ts"),
    undefined,
  );
});

test("both presentation contracts require the actual dispatcher", () => {
  for (const id of ["hosted-secret-drop", "portable-secret-drop"]) {
    assert.ok(CORE_CONTRACTS[id].implementation.includes(OPEN), id);
    assert.ok(
      CORE_CONTRACTS[id].regressions.includes(
        "packages/app-core/src/lib/vault/drop-present.test.ts",
      ),
      id,
    );
  }
});

const mutations = [
  [
    "portable proof dispatch",
    OPEN,
    "return presentPortable(bearerToken, userCode, pkt);",
    "return presentRemote(bearerToken, userCode);",
  ],
  [
    "manifest admission",
    OPEN,
    "return { targetManifest: guardManifest(presented.targetManifest) };",
    "return { targetManifest: presented.targetManifest };",
  ],
  ["query-secret refusal", LINK, LEAK_CHECK, "const leaked = false;"],
  [
    "memory-only drop custody",
    `${CLAIMS}arrival.ts`,
    "  held = arrival;",
    '  held = arrival;\n  localStorage.setItem("unchecked-arrival", JSON.stringify(arrival));',
  ],
  [
    "tab-scoped claim stash",
    `${CLAIMS}stash.ts`,
    "maybeSessionStore() ?? null",
    "globalThis.localStorage",
  ],
  [
    "payload key entropy",
    "packages/vault-core/src/crypto.ts",
    "return crypto.getRandomValues(new Uint8Array(length));",
    "return new Uint8Array(length);",
  ],
  [
    "payload AEAD",
    "packages/vault-core/src/drop-format.ts",
    '{ name: "AES-GCM", iv: overlapCast(b64ToBytes(nonce)) }',
    '{ name: "AES-CBC", iv: overlapCast(b64ToBytes(nonce)) }',
  ],
  [
    "vault-format export routing",
    "packages/vault-core/src/index.ts",
    'export * from "./drop-format.js";',
    'export * from "./unchecked-drop-format.js";',
  ],
  [
    "claim package routing",
    "packages/app-core/package.json",
    '"default": "./src/*.ts"',
    '"default": "./unchecked/*.ts"',
  ],
  [
    "claim route key custody",
    ROUTE,
    "fragmentKey={drop.key}",
    'fragmentKey=""',
  ],
  [
    "discarded-link lifecycle",
    "apps/pages/src/modules/identity.ceremonies/ClaimDifferentLink.tsx",
    "onClick={onChoose}",
    "onClick={() => {}}",
  ],
];

for (const [name, path, before, after] of mutations) {
  test(`the actual gate rejects an unreviewed change to ${name}`, (t) => {
    const f = gateFixture(t);
    assertClean(f.run());
    f.replace(path, before, after);
    assertBlocked(f.run(), /EM-DRIFT: reviewed implementation changed/u);
  });
}

test("a portable binding cannot satisfy the hosted dispatch contract", (t) => {
  const f = gateFixture(t);
  const value = JSON.parse(f.read(POLICY));
  const hosted = value.surfaces.find((row) => row.id === "hosted-secret-drop");
  hosted.implementation = hosted.implementation.filter((path) => path !== OPEN);
  f.write(POLICY, JSON.stringify(value));
  assertBlocked(f.run(), /EM-BINDING: hosted-secret-drop is missing/u);
});

test("an unstaged URL-secret repair cannot mask the unsafe index", (t) => {
  const f = gateFixture(t);
  f.replace(LINK, LEAK_CHECK, "const leaked = false;");
  f.git(["add", LINK]);
  f.restore(LINK);
  assertClean(f.run());
  assertBlocked(
    f.run(["--staged"]),
    /EM-DRIFT: reviewed implementation changed/u,
  );
});

test("new nested release helpers require classification in both snapshots", (t) => {
  const f = gateFixture(t);
  const path = `${CLAIMS}drop-open/nested/release.ts`;
  f.write(path, "export const present = () => ({ targetManifest: {} });\n");
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
  f.git(["add", path]);
  assertBlocked(
    f.run(["--staged"]),
    /EM-COVERAGE: unclassified protected source/u,
  );
});

for (const path of [
  `${CLAIMS}drop-open-helper.ts`,
  `${CLAIMS}arrival-helper.ts`,
  "packages/ceremony-kit/src/claim-link-helper.ts",
  "packages/vault-core/src/drop-format-helper.ts",
]) {
  test(`new prefixed helper requires classification: ${path}`, (t) => {
    const f = gateFixture(t);
    f.write(path, "export const unchecked = true;\n");
    assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
    f.git(["add", path]);
    assertBlocked(
      f.run(["--staged"]),
      /EM-COVERAGE: unclassified protected source/u,
    );
  });
}
