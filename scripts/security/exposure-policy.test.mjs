import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  exposureViolations,
  parsePolicy,
  validatePolicy,
} from "../lib/exposure-policy.mjs";

const baseline = parsePolicy(
  readFileSync(
    new URL("../../tools/security/exposure-matrix.json", import.meta.url),
  ),
);
const matrix = () => structuredClone(baseline);
const row = (value, id) => value.surfaces.find((surface) => surface.id === id);
const rules = (value) =>
  exposureViolations(validatePolicy(value)).map((violation) => violation.rule);

test("reviewed matrix permits public RSA keys and explicit portable-copy limits", () => {
  assert.deepEqual(rules(matrix()), []);
  const keys = row(baseline, "public-signing-keys");
  assert.deepEqual(keys.artifacts, ["public-key"]);
  assert.equal(row(baseline, "portable-secret-drop").entropyBits, 80);
  assert.deepEqual(row(baseline, "share-lifecycle").guarantees, []);
});

const forbidden = [
  [
    "optional server code",
    "hosted-secret-drop",
    (surface) => {
      surface.controls = [];
    },
    "EM-ONLINE-PROOF",
  ],
  [
    "client-only code gate",
    "hosted-secret-drop",
    (surface) => {
      surface.verification = "client-only";
    },
    "EM-KEY-CIPHERTEXT",
  ],
  [
    "no bearer admission",
    "hosted-secret-drop",
    (surface) => {
      surface.controls = ["mandatory-proof"];
    },
    "EM-BEARER-FIRST",
  ],
  [
    "public signing secret",
    "public-signing-keys",
    (surface) => {
      surface.artifacts.push("private-key");
    },
    "EM-SECRET-PROJECTION",
  ],
  [
    "public OTP seed",
    "public-signing-keys",
    (surface) => {
      surface.artifacts.push("otp-seed");
    },
    "EM-SECRET-PROJECTION",
  ],
  [
    "exposed offline code verifier",
    "public-signing-keys",
    (surface) => {
      surface.artifacts.push("code-verifier");
    },
    "EM-SECRET-PROJECTION",
  ],
  [
    "private-field deletion projection",
    "public-signing-keys",
    (surface) => {
      surface.controls = [];
    },
    "EM-PUBLIC-KEYS",
  ],
  [
    "portable code with only forty bits",
    "portable-secret-drop",
    (surface) => {
      surface.entropyBits = 40;
    },
    "EM-OFFLINE-CODE",
  ],
  [
    "unbounded portable KDF",
    "portable-secret-drop",
    (surface) => {
      surface.controls = ["code-derived-aead", "cryptographic-random"];
    },
    "EM-OFFLINE-CODE",
  ],
  [
    "portable ciphertext beside its key",
    "portable-secret-drop",
    (surface) => {
      surface.verification = "client-only";
    },
    "EM-KEY-CIPHERTEXT",
  ],
  [
    "offline one-use claim",
    "portable-secret-drop",
    (surface) => {
      surface.guarantees = ["single-use"];
      surface.enforcement = "authoritative";
    },
    "EM-LIFECYCLE",
  ],
  [
    "revocation borrowed from another endpoint",
    "share-lifecycle",
    (surface) => {
      surface.guarantees = ["revocation"];
      surface.enforcement = "authoritative";
    },
    "EM-LIFECYCLE",
  ],
  [
    "secondary listener omitted",
    "host-listeners",
    (surface) => {
      surface.controls = ["explicit-network-bind", "joined-listener-lifetime"];
    },
    "EM-LISTENERS",
  ],
  [
    "detached listener",
    "host-listeners",
    (surface) => {
      surface.controls = ["all-listeners-classified", "explicit-network-bind"];
    },
    "EM-LISTENERS",
  ],
  [
    "implicit proof-policy weakening",
    "est-policy",
    (surface) => {
      surface.controls = [];
    },
    "EM-POLICY-OMISSION",
  ],
  [
    "four-byte stored enrollment credential",
    "est-password",
    (surface) => {
      surface.minSecretBytes = 4;
    },
    "EM-WEAK-ENROLLMENT",
  ],
  [
    "ingress leaf substituted for client",
    "certificate-binding",
    (surface) => {
      surface.controls = [];
    },
    "EM-ORIGINATING-CLIENT",
  ],
];
for (const [name, id, mutate, expected] of forbidden) {
  test(`forbids ${name}`, () => {
    const value = matrix();
    mutate(row(value, id));
    assert.ok(rules(value).includes(expected));
  });
}

for (const [field, value] of [
  ["storage", "process-local"],
  ["admission", "after-verification"],
  ["atomicity", "read-then-write"],
  ["eviction", "live-eviction"],
  ["sharing", "per-route"],
  ["scope", "activation"],
  ["scope", "ip"],
  ["scope", "global"],
]) {
  test(`oracle budget rejects ${field}=${value}`, () => {
    const policy = matrix();
    row(policy, "account-totp").budget[field] = value;
    assert.ok(rules(policy).includes("EM-GUESS-BUDGET"));
  });
}

test("changing the owner to an unrelated durable bucket does not count as protection", () => {
  const value = matrix();
  row(value, "account-totp").budget.scope = "send";
  assert.ok(rules(value).includes("EM-BUDGET-SCOPE"));
});

test("splitting ciphertext and payload key into separate endpoints does not hide co-exposure", () => {
  const value = matrix();
  const common = row(value, "share-lifecycle");
  value.surfaces.push({
    ...structuredClone(common),
    id: "ciphertext-endpoint",
    flow: "split-flow",
    artifacts: ["ciphertext"],
    verification: "client-only",
  });
  value.surfaces.push({
    ...structuredClone(common),
    id: "key-endpoint",
    flow: "split-flow",
    artifacts: ["payload-key"],
    verification: "none",
    controls: [],
    enforcement: "none",
  });
  const violations = exposureViolations(validatePolicy(value));
  assert.ok(
    violations.some(
      (item) =>
        item.surface === "ciphertext-endpoint" &&
        item.rule === "EM-KEY-CIPHERTEXT",
    ),
  );
});

test("key custody by a different authorized observer does not falsely imply public disclosure", () => {
  const value = matrix();
  const common = row(value, "share-lifecycle");
  value.surfaces.push({
    ...structuredClone(common),
    id: "public-ciphertext",
    flow: "separate-custody",
    observer: "public",
    artifacts: ["ciphertext"],
  });
  value.surfaces.push({
    ...structuredClone(common),
    id: "recipient-key",
    flow: "separate-custody",
    observer: "authorized-recipient",
    artifacts: ["payload-key"],
    controls: ["explicit-export-grant", "recipient-bound", "step-up"],
  });
  assert.deepEqual(rules(value), []);
});

test("an authorized export still requires grant, recipient binding and step-up", () => {
  const value = matrix();
  const common = row(value, "share-lifecycle");
  value.surfaces.push({
    ...structuredClone(common),
    id: "credential-export",
    observer: "authorized-recipient",
    artifacts: ["private-key"],
  });
  assert.ok(rules(value).includes("EM-EXPORT"));
  value.surfaces.at(-1).controls = [
    "explicit-export-grant",
    "recipient-bound",
    "step-up",
  ];
  assert.deepEqual(rules(value), []);
});

const invalid = [
  [
    "unknown version",
    (value) => {
      value.version = 2;
    },
  ],
  [
    "unknown policy field",
    (value) => {
      value.ignore = true;
    },
  ],
  [
    "empty surfaces",
    (value) => {
      value.surfaces = [];
    },
  ],
  [
    "duplicate surface",
    (value) => {
      value.surfaces.push(value.surfaces[0]);
    },
  ],
  [
    "deleted required surface",
    (value) => {
      value.surfaces.shift();
    },
  ],
  [
    "weakened required observer",
    (value) => {
      row(value, "public-signing-keys").observer = "device-owner";
    },
  ],
  [
    "reclassified required boundary",
    (value) => {
      row(value, "portable-secret-drop").kind = "projection";
    },
  ],
  [
    "empty implementation",
    (value) => {
      value.surfaces[0].implementation = [];
    },
  ],
  [
    "empty regressions",
    (value) => {
      value.surfaces[0].regressions = [];
    },
  ],
  [
    "unknown control",
    (value) => {
      value.surfaces[0].controls.push("captcha-is-enough");
    },
  ],
  [
    "unknown artifact",
    (value) => {
      value.surfaces[0].artifacts.push("trust-me");
    },
  ],
  [
    "duplicate control",
    (value) => {
      value.surfaces[0].controls.push(value.surfaces[0].controls[0]);
    },
  ],
  [
    "empty fingerprint inventory",
    (value) => {
      value.sources = {};
    },
  ],
  [
    "invalid fingerprint",
    (value) => {
      value.sources[Object.keys(value.sources)[0]] = "1234";
    },
  ],
  [
    "unbound fingerprint",
    (value) => {
      value.sources["unused.ts"] = "a".repeat(64);
    },
  ],
  [
    "no review reason",
    (value) => {
      value.surfaces[0].review = "";
    },
  ],
];
for (const [name, mutate] of invalid) {
  test(`schema refuses ${name}`, () => {
    const value = matrix();
    mutate(value);
    assert.throws(() => validatePolicy(value), /EM-SCHEMA/u);
  });
}

test("duplicate JSON fields, including escaped names, cannot override unsafe declarations", () => {
  for (const key of ['"version"', '"ver\\u0073ion"']) {
    const raw = JSON.stringify(baseline).replace(
      '"version":1',
      `"version":1,${key}:1`,
    );
    assert.throws(
      () => parsePolicy(Buffer.from(raw)),
      /duplicate JSON property/u,
    );
  }
  assert.throws(() => parsePolicy(Buffer.from('{"version":')), SyntaxError);
  assert.throws(() => parsePolicy(Buffer.from([0xff])), /encoded data/u);
});
