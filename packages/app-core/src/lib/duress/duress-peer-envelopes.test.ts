import { describe, expect, it } from "vitest";
import {
  generatePeerKeyPair,
  signPeerEnvelope,
  verifyPeerEnvelope,
} from "./peer/envelope.js";

describe("peer envelopes", () => {
  it("verifies signatures and rejects wrong audience", async () => {
    const kp = await generatePeerKeyPair();
    const env = await signPeerEnvelope(
      {
        issuer: "device-a",
        audience: "receiver-1",
        principalRef: "p1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        operation: "quarantine_device",
        incidentId: "i1",
        policyRevision: 1,
        keyEpoch: 1,
        nonce: "n1",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ciphertextB64: btoa("hi"),
      },
      kp.privateKey,
    );
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
        { audience: "other", permittedOperations: ["quarantine_device"] },
        new Set(),
      ),
    ).toMatchObject({ ok: false });
  });
});
