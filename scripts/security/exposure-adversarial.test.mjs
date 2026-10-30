import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { coverageViolations } from "../lib/exposure-coverage.mjs";
import {
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";
import { worktreeSnapshot } from "../lib/exposure-snapshot.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const snapshot = worktreeSnapshot(root);
const baseline = parsePolicy(
  readFileSync(
    new URL("../../tools/security/exposure-matrix.json", import.meta.url),
  ),
);
const matrix = () => structuredClone(baseline);
const row = (value, id) => value.surfaces.find((surface) => surface.id === id);

function issues(value) {
  try {
    validatePolicy(value);
  } catch (error) {
    return [error.message];
  }
  return [
    ...exposureViolations(value).map(
      (finding) => `${finding.rule}: ${finding.surface}: ${finding.reason}`,
    ),
    ...coverageViolations(value, snapshot),
  ];
}

function forbidden(value, expected) {
  const found = issues(value);
  assert.ok(
    found.some((message) => expected.test(message)),
    found.join("\n") ||
      "Unsafe composition passed both policy and source coverage",
  );
}

function extra(value, id, changes) {
  const common = structuredClone(row(value, "share-lifecycle"));
  const added = { ...common, id, flow: "adversarial-flow", ...changes };
  value.surfaces.push(added);
  return added;
}

test("the actual reviewed source snapshot passes before adversarial mutations", () => {
  assert.deepEqual(issues(matrix()), []);
});

for (const [cipherObserver, keyObserver] of [
  ["link-holder", "public"],
  ["public", "link-holder"],
]) {
  test(`joins ${cipherObserver} ciphertext with ${keyObserver} payload key`, () => {
    const value = matrix();
    extra(value, "exposed-ciphertext", {
      observer: cipherObserver,
      artifacts: ["ciphertext"],
      verification: "client-only",
    });
    extra(value, "exposed-payload-key", {
      observer: keyObserver,
      artifacts: ["payload-key"],
    });
    forbidden(value, /EM-KEY-CIPHERTEXT/u);
  });
}

test("genuinely withheld payload key protects independently readable ciphertext", () => {
  const value = matrix();
  extra(value, "ungated-ciphertext", {
    observer: "link-holder",
    artifacts: ["ciphertext"],
    verification: "client-only",
  });
  extra(value, "proof-labelled-public-key", {
    observer: "public",
    artifacts: ["payload-key"],
    verification: "server",
    controls: ["mandatory-proof"],
    enforcement: "authoritative",
  });
  assert.deepEqual(issues(value), []);
  extra(value, "another-unguarded-key-release", {
    observer: "link-holder",
    artifacts: ["payload-key"],
  });
  forbidden(value, /EM-KEY-CIPHERTEXT/u);
});

for (const id of ["hosted-link-key", "portable-link-key"]) {
  for (const change of [{ artifacts: [] }, { verification: "server" }]) {
    test(`${id} cannot hide or gate its already link-visible key: ${JSON.stringify(change)}`, () => {
      const value = matrix();
      Object.assign(row(value, id), change);
      forbidden(value, /EM-SCHEMA/u);
    });
  }
}

for (const [id, flow] of [
  ["hosted-secret-drop", "hosted-secret-drop"],
  ["portable-secret-drop", "portable-secret-drop"],
]) {
  test(`${id} cannot leak another ciphertext copy while the fragment key is visible`, () => {
    const value = matrix();
    extra(value, "unguarded-ciphertext-copy", {
      flow,
      observer: "public",
      artifacts: ["ciphertext"],
    });
    forbidden(value, /EM-KEY-CIPHERTEXT/u);
  });
}

test("new online guess oracles require an explicitly reviewed budget contract", () => {
  const value = matrix();
  extra(value, "future-four-digit-oracle", {
    flow: "future-otp",
    kind: "online",
    observer: "public",
    artifacts: ["guess-oracle"],
    verification: "server",
    controls: ["mandatory-proof"],
    enforcement: "authoritative",
    entropyBits: 13,
    budget: {
      ...row(value, "account-totp").budget,
      limit: 20,
      windowSeconds: 1,
    },
  });
  forbidden(value, /EM-ORACLE-CONTRACT/u);
});

for (const control of [
  "confined-import-paths",
  "bounded-import-input",
  "pinned-import-origin",
]) {
  test(`privileged import cannot omit ${control}`, () => {
    const value = matrix();
    const imports = row(value, "bitwarden-import");
    imports.controls = imports.controls.filter((item) => item !== control);
    forbidden(value, /EM-IMPORT-CUSTODY/u);
  });
}

test("portable lifecycle UI cannot detach its flow and advertise authoritative revocation", () => {
  const value = matrix();
  Object.assign(row(value, "share-lifecycle"), {
    flow: "unrelated-online-flow",
    guarantees: ["single-use", "expiry", "revocation"],
    enforcement: "authoritative",
  });
  forbidden(value, /EM-(?:SCHEMA|LIFECYCLE|CONTRACT)/u);
});

for (const id of [
  "hosted-secret-drop",
  "account-totp",
  "est-password",
  "bitwarden-account",
  "bitwarden-send",
  "bitwarden-api-key",
  "bitwarden-device-code",
]) {
  for (const enforcement of ["none", "advisory"]) {
    test(`${id} cannot rely on ${enforcement} proof enforcement`, () => {
      const value = matrix();
      row(value, id).enforcement = enforcement;
      forbidden(value, /EM-ONLINE-PROOF/u);
    });
  }
  test(`${id} cannot weaken its reviewed budget to twenty guesses per second`, () => {
    const value = matrix();
    Object.assign(row(value, id).budget, { limit: 20, windowSeconds: 1 });
    forbidden(value, /EM-(?:SCHEMA|GUESS-BUDGET|BUDGET|CONTRACT)/u);
  });
}

test("a core certificate proof cannot borrow another row's test-support binding", () => {
  const value = matrix();
  const proof = "crates/gateway/src/transport/proof.rs";
  assert.ok(row(value, "host-listeners").implementation.includes(proof));
  assert.ok(Object.hasOwn(value.sources, proof));
  row(value, "certificate-binding").implementation = [
    "crates/gateway/src/transport/test_support.rs",
  ];
  forbidden(value, /EM-(?:SCHEMA|COVERAGE|BINDING|CONTRACT)/u);
});

for (const control of ["originating-client-proof", "exact-bootstrap-trust"]) {
  test(`EST certificate proof cannot omit ${control}`, () => {
    const value = matrix();
    const est = row(value, "est-client-certificate");
    est.controls = est.controls.filter((item) => item !== control);
    forbidden(value, /EM-(?:ORIGINATING-CLIENT|BOOTSTRAP-TRUST)/u);
  });
}

for (const material of ["raw-secret", "private-key"]) {
  test(`ordinary authenticated observers cannot receive ${material} without export authorization`, () => {
    const value = matrix();
    extra(value, "authenticated-ungranted-export", {
      observer: "authenticated",
      artifacts: [material],
    });
    forbidden(value, /EM-(?:SECRET-PROJECTION|EXPORT|RECIPIENT)/u);
  });
}

test("changing a protected core observer to device-owner does not legalize an exposure", () => {
  const value = matrix();
  Object.assign(row(value, "public-signing-keys"), {
    observer: "device-owner",
    artifacts: ["private-key"],
  });
  forbidden(value, /EM-(?:SCHEMA|SECRET-PROJECTION|CONTRACT)/u);
});

test("a genuine authorized recipient export retains all three controls", () => {
  const value = matrix();
  extra(value, "authorized-export", {
    observer: "authorized-recipient",
    artifacts: ["private-key", "raw-secret"],
    controls: ["explicit-export-grant", "recipient-bound", "step-up"],
  });
  assert.deepEqual(issues(value), []);
});

test("local device-owner custody is distinct from public export", () => {
  const value = matrix();
  extra(value, "unlocked-local-custody", {
    observer: "device-owner",
    artifacts: ["private-key", "raw-secret", "ciphertext", "payload-key"],
  });
  assert.deepEqual(issues(value), []);
});

test("public RSA material beside ciphertext remains allowed without a payload key", () => {
  const value = matrix();
  extra(value, "public-encryption-material", {
    observer: "public",
    artifacts: ["public-key", "public-certificate", "ciphertext"],
  });
  assert.deepEqual(issues(value), []);
});

test("an authorized recipient's key does not imply a public ciphertext reader has it", () => {
  const value = matrix();
  extra(value, "public-ciphertext", {
    observer: "public",
    artifacts: ["ciphertext"],
  });
  extra(value, "recipient-held-key", {
    observer: "authorized-recipient",
    artifacts: ["payload-key"],
    controls: ["explicit-export-grant", "recipient-bound", "step-up"],
  });
  assert.deepEqual(issues(value), []);
});
