import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { exposureViolations } from "../lib/exposure-rules.mjs";

// These tests isolate observer composition. Schema, reviewed fingerprints and
// snapshot integrity are checked separately by the policy and gate suites.
const baseline = JSON.parse(
  readFileSync(
    new URL("../../tools/security/exposure-matrix.json", import.meta.url),
    "utf8",
  ),
);
const cohorts = ["public", "link-holder", "authenticated", "network-peer"];

function fixture(cipherObserver, keyObserver, keyChanges = {}) {
  const value = structuredClone(baseline);
  const common = structuredClone(
    value.surfaces.find((row) => row.id === "hosted-link-key"),
  );
  value.surfaces.push(
    {
      ...common,
      id: "observer-ciphertext",
      flow: "observer-compatible-flow",
      observer: cipherObserver,
      artifacts: ["ciphertext"],
    },
    {
      ...common,
      id: "observer-key",
      flow: "observer-compatible-flow",
      observer: keyObserver,
      artifacts: ["payload-key"],
      ...keyChanges,
    },
  );
  return value;
}

const pairViolations = (value) =>
  exposureViolations(value).filter((finding) =>
    finding.surface.startsWith("observer-"),
  );

for (const cipherObserver of cohorts) {
  for (const keyObserver of cohorts) {
    test(`same-flow ${cipherObserver} ciphertext composes with ${keyObserver} payload key`, () => {
      const failures = pairViolations(fixture(cipherObserver, keyObserver));
      assert.ok(
        failures.some((finding) => finding.rule === "EM-KEY-CIPHERTEXT"),
        "A caller may hold a link, sign in, and reach the service; those properties do not confer an export grant",
      );
    });
  }
}

test("a genuinely withheld key still protects public ciphertext across compatible cohorts", () => {
  const value = fixture("link-holder", "authenticated", {
    verification: "server",
    controls: ["mandatory-proof"],
    enforcement: "authoritative",
  });
  assert.deepEqual(pairViolations(value), []);
});

test("a second unguarded key release defeats a protected key endpoint", () => {
  const value = fixture("link-holder", "authenticated", {
    verification: "server",
    controls: ["mandatory-proof"],
    enforcement: "authoritative",
  });
  value.surfaces.push({
    ...structuredClone(value.surfaces.at(-1)),
    id: "observer-second-key",
    observer: "network-peer",
    verification: "none",
    controls: [],
    enforcement: "none",
  });
  assert.ok(
    pairViolations(value).some(
      (finding) => finding.rule === "EM-KEY-CIPHERTEXT",
    ),
  );
});

for (const custody of ["authorized-recipient", "device-owner"]) {
  test(`${custody} key custody does not become available to a generic link holder`, () => {
    const value = fixture("link-holder", custody, {
      controls:
        custody === "authorized-recipient"
          ? ["explicit-export-grant", "recipient-bound", "step-up"]
          : [],
    });
    assert.deepEqual(pairViolations(value), []);
  });
}

test("different flows do not combine merely because their generic observer labels are compatible", () => {
  const value = fixture("link-holder", "authenticated");
  value.surfaces.at(-1).flow = "another-resource-flow";
  assert.deepEqual(pairViolations(value), []);
});

test("an authenticated offline copy prevents link-holder global lifecycle claims in the same flow", () => {
  const value = fixture("link-holder", "authenticated", {
    kind: "offline",
    verification: "code-aead",
    controls: ["code-derived-aead", "bounded-kdf", "cryptographic-random"],
    entropyBits: 80,
    enforcement: "advisory",
  });
  Object.assign(value.surfaces.at(-2), {
    guarantees: ["single-use", "expiry", "revocation"],
    enforcement: "authoritative",
  });
  assert.ok(
    pairViolations(value).some((finding) => finding.rule === "EM-LIFECYCLE"),
  );
});
