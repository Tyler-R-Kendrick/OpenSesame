/**
 * REDTEAM-C: Mutate policy / envelope / share / epoch checks — fail closed.
 */

import {
  PolicyDocumentSchema,
  PolicyProfileSchema,
  compileDuressPolicy,
} from "@opensesame/contracts";
import { defined } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSafePeerOrigin,
  generatePeerKeyPair,
  signPeerEnvelope,
  verifyPeerEnvelope,
} from "../peer/envelope.js";
import { RT_CATALOG, alertOnlyPolicy } from "./fixtures.js";

describe("REDTEAM-C fuzz: policy mutations", () => {
  it("unknown security-altering fields fail closed", () => {
    const result = compileDuressPolicy(
      alertOnlyPolicy({ silentBypass: true, autoArm: true }),
      RT_CATALOG,
    );
    expect(result.ok).toBe(false);
  });

  it("import enabled:true never arms", () => {
    const result = compileDuressPolicy(
      alertOnlyPolicy({ enabled: true }),
      RT_CATALOG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.armed).toBe(false);
  });

  it("decoy with shared-root compartment rejected", () => {
    const base = alertOnlyPolicy();
    const profile0 = defined(base.profiles[0], "value");
    const doc = PolicyDocumentSchema.parse({
      ...base,
      profiles: [
        PolicyProfileSchema.parse({
          ...profile0,
          profileId: "decoy",
          effects: {
            presentation: "decoy",
            presentationCompartmentRef: "comp-normal",
            hold: { kind: "none" },
            alert: null,
            quarantinePeerRefs: [],
            providerRevocationRefs: [],
            removal: { kind: "none" },
            recoveryPolicyRef: null,
            operationCeilingRef: "ceiling-restricted",
          },
        }),
      ],
    });
    const result = compileDuressPolicy(doc, RT_CATALOG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.diagnostics.some((d) => d.code === "independent_keys_required"),
      ).toBe(true);
    }
  });

  it("prf_and_code with alternate unlock path rejected", () => {
    const catalog = {
      ...RT_CATALOG,
      alternateUnlockPaths: [
        { label: "legacy-password-wrap", bypassesClaim: true },
      ],
    };
    const base = alertOnlyPolicy();
    const profile0 = defined(base.profiles[0], "value");
    const doc = PolicyDocumentSchema.parse({
      ...base,
      profiles: [
        PolicyProfileSchema.parse({
          ...profile0,
          triggerKind: "prf_and_code",
          effects: {
            presentation: "restricted",
            presentationCompartmentRef: "comp-restricted",
            hold: { kind: "none" },
            alert: null,
            quarantinePeerRefs: [],
            providerRevocationRefs: [],
            removal: { kind: "none" },
            recoveryPolicyRef: null,
            operationCeilingRef: "ceiling-restricted",
          },
        }),
      ],
    });
    const result = compileDuressPolicy(doc, RT_CATALOG);
    // Use mutated catalog
    const result2 = compileDuressPolicy(doc, catalog);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(
        result2.diagnostics.some((d) => d.code === "alternate_unlock_bypass"),
      ).toBe(true);
    }
    void result;
  });

  it("canary + removal is contradictory", () => {
    const base = alertOnlyPolicy();
    const profile0 = defined(base.profiles[0], "value");
    const doc = PolicyDocumentSchema.parse({
      ...base,
      profiles: [
        PolicyProfileSchema.parse({
          ...profile0,
          triggerKind: "canary_activation",
          effects: {
            presentation: "unchanged",
            presentationCompartmentRef: null,
            hold: { kind: "none" },
            alert: {
              routeRef: "route-alert-1",
              templateRef: "tpl",
              retainOutboxAcrossRemoval: false,
              maxRetries: 1,
              expiryMs: 60_000,
            },
            quarantinePeerRefs: [],
            providerRevocationRefs: [],
            removal: {
              kind: "local_enumerated",
              resourceRefs: ["comp-normal"],
              preserveSealedOutbox: false,
              acceptUnrecoverability: true,
            },
            recoveryPolicyRef: null,
            operationCeilingRef: null,
          },
        }),
      ],
    });
    const result = compileDuressPolicy(doc, RT_CATALOG);
    expect(result.ok).toBe(false);
  });

  it("mutated schemaVersion fails closed", () => {
    const result = compileDuressPolicy(
      { ...alertOnlyPolicy(), schemaVersion: 99 },
      RT_CATALOG,
    );
    expect(result.ok).toBe(false);
  });
});

describe("REDTEAM-C fuzz: peer envelope mutations", () => {
  it("replay nonce, wrong audience, expired, alg none", async () => {
    const kp = await generatePeerKeyPair();
    const base = {
      issuer: "device-a",
      audience: "receiver-1",
      principalRef: "p1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      operation: "quarantine_device",
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      nonce: "nonce-rt-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payloadB64: btoa("payload"),
    };
    const env = await signPeerEnvelope(base, kp.privateKey);
    const seen = new Set<string>();
    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        { audience: "receiver-1", permittedOperations: ["quarantine_device"] },
        seen,
      ),
    ).toEqual({ ok: true });
    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        { audience: "receiver-1", permittedOperations: ["quarantine_device"] },
        seen,
      ),
    ).toMatchObject({ ok: false, code: "ambiguous_trigger" });

    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        { audience: "other", permittedOperations: ["quarantine_device"] },
        new Set(),
      ),
    ).toMatchObject({ ok: false });

    const shortLived = await signPeerEnvelope(
      {
        ...base,
        nonce: "nonce-expired",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      },
      kp.privateKey,
    );
    expect(
      await verifyPeerEnvelope(
        shortLived,
        kp.publicKey,
        {
          audience: "receiver-1",
          permittedOperations: ["quarantine_device"],
          now: Date.now() + 60_000,
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, code: "stale_session" });

    await expect(
      signPeerEnvelope({ ...base, nonce: "n2", alg: "none" }, kp.privateKey),
    ).rejects.toThrow(/none/);
  });

  it("rejects unsafe peer origins", () => {
    expect(() => assertSafePeerOrigin("http://evil.example/x")).toThrow(
      /unapproved_route/,
    );
    expect(() =>
      assertSafePeerOrigin("https://user:pass@evil.example/"),
    ).toThrow(/unapproved_route/);
    expect(() => assertSafePeerOrigin("https://peer.example/ok")).not.toThrow();
  });
});
