import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceArea } from "../lib/exposure-coverage.mjs";
import {
  POLICY,
  assertBlocked,
  assertClean,
  gateFixture,
} from "./exposure-gate-fixture.mjs";

const HELPER = "packages/os-domain/src/crypto/claim-token.ts";
const USER_CHECK =
  "const digest = digestUserCode(pepper, claimId, code);\n  return constantTimeEqual(digest, expectedDigest);";

test("shared claim verification and package/export routing remain inside source discovery", () => {
  for (const path of [
    "packages/control-plane/package.json",
    "packages/os-domain/package.json",
    "packages/os-domain/src/index.ts",
    "packages/os-domain/src/json.ts",
    HELPER,
    "packages/os-domain/src/crypto/claim-token/nested/verify.ts",
  ]) {
    assert.equal(sourceArea(path), "hosted-drop", path);
  }
});

const mutations = [
  ["user-code acceptance", HELPER, USER_CHECK, "return true;"],
  [
    "bearer acceptance",
    HELPER,
    "const digest = digestClaimToken(pepper, token);\n  if (!digest) {\n    return false;\n  }\n  return constantTimeEqual(digest, expectedDigest);",
    "return true;",
  ],
  [
    "code generation entropy",
    HELPER,
    "const bytes = randomBytes(byteCount);",
    "const bytes = Buffer.alloc(byteCount);",
  ],
  [
    "bearer generation entropy",
    HELPER,
    "secretBytes: Buffer = randomBytes(32)",
    "secretBytes: Buffer = Buffer.alloc(32)",
  ],
  [
    "domain export routing",
    "packages/os-domain/src/index.ts",
    'export * from "./crypto/claim-token.js";',
    'export * from "./crypto/claim-token.js";\nexport const verifyUserCode = (..._args: unknown[]) => true;',
  ],
  [
    "package runtime export routing",
    "packages/os-domain/package.json",
    '"default": "./src/index.ts"',
    '"default": "./src/unchecked-claims.ts"',
  ],
  [
    "importing package verifier routing",
    "packages/control-plane/package.json",
    '"@opensesame/os-domain": "*"',
    '"@opensesame/os-domain": "npm:unchecked-claims@1.0.0"',
  ],
  [
    "shared primitive admission",
    "packages/os-domain/src/json.ts",
    'return hasPrimitiveTag(value, "[object String]");',
    "return true;",
  ],
];

for (const [name, path, before, after] of mutations) {
  test(`the actual gate rejects a change to ${name} without a route change`, (t) => {
    const f = gateFixture(t);
    assertClean(f.run());
    const policyBefore = f.read(POLICY);
    f.replace(path, before, after);
    assertBlocked(f.run(), /EM-DRIFT: reviewed implementation changed/u);
    assert.equal(f.read(POLICY), policyBefore);
  });
}

test("an unstaged shared-helper repair cannot mask staged code acceptance", (t) => {
  const f = gateFixture(t);
  f.replace(HELPER, USER_CHECK, "return true;");
  f.git(["add", HELPER]);
  f.restore(HELPER);
  assertClean(f.run());
  assertBlocked(
    f.run(["--staged"]),
    /EM-DRIFT: reviewed implementation changed: packages\/os-domain\/src\/crypto\/claim-token\.ts/u,
  );
});

test("another surface cannot satisfy the hosted drop's required verifier binding", (t) => {
  const f = gateFixture(t);
  const value = JSON.parse(f.read(POLICY));
  const hosted = value.surfaces.find((row) => row.id === "hosted-secret-drop");
  hosted.implementation = hosted.implementation.filter(
    (path) => path !== HELPER,
  );
  value.surfaces.push({
    ...structuredClone(
      value.surfaces.find((row) => row.id === "hosted-link-key"),
    ),
    id: "another-verifier-owner",
    area: "hosted-drop",
    flow: "another-verifier-owner",
    artifacts: [],
    implementation: [HELPER],
  });
  f.write(POLICY, JSON.stringify(value));
  assertBlocked(
    f.run(),
    /EM-BINDING: hosted-secret-drop is missing its implementation binding packages\/os-domain\/src\/crypto\/claim-token\.ts/u,
  );
});

test("new nested verifier modules require explicit classification", (t) => {
  const f = gateFixture(t);
  const path = "packages/os-domain/src/crypto/claim-token/nested/verify.ts";
  f.write(path, "export function verifyUserCode() { return true; }\n");
  assertBlocked(f.run(), /EM-COVERAGE: unclassified protected source/u);
  f.git(["add", path]);
  assertBlocked(
    f.run(["--staged"]),
    /EM-COVERAGE: unclassified protected source/u,
  );
});
