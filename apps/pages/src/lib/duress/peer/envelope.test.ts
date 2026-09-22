import { describe, expect, it } from "vitest";
import {
  PeerPairingRegistry,
  assertSafePeerOrigin,
  encryptPeerPayload,
  exportPeerPairing,
  generatePeerKeyPair,
  generatePeerWrapKey,
  importPeerPairing,
  peerExportToQrSvg,
  signPeerEnvelope,
  tailscaleEvidenceOnly,
  verifyPeerEnvelope,
} from "./index.js";

describe("PEER envelopes", () => {
  it("signs/verifies and rejects wrong audience, replay, none alg, SSRF", async () => {
    const kp = await generatePeerKeyPair();
    const wrap = await generatePeerWrapKey();
    const ct = await encryptPeerPayload(new TextEncoder().encode("{}"), wrap);
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
        ciphertextB64: ct,
      },
      kp.privateKey,
    );
    const seen = new Set<string>();
    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        {
          audience: "receiver-1",
          permittedOperations: ["quarantine_device"],
          vaultRef: "v1",
        },
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
    ).toMatchObject({ ok: false, code: "scope_mismatch" });

    await expect(
      signPeerEnvelope(
        {
          alg: "none",
          issuer: "a",
          audience: "b",
          principalRef: "p",
          vaultRef: "v",
          deviceBindingRef: "d",
          operation: "x",
          incidentId: "i",
          policyRevision: 1,
          keyEpoch: 1,
          nonce: "n",
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000).toISOString(),
          ciphertextB64: "",
        },
        kp.privateKey,
      ),
    ).rejects.toThrow(/none/);

    expect(() => assertSafePeerOrigin("http://169.254.169.254/")).toThrow();
    expect(tailscaleEvidenceOnly("user@tailnet")).toEqual({
      kind: "tailscale_evidence",
      identity: "user@tailnet",
      vaultAuthority: false,
      certWeakening: false,
    });
    expect(tailscaleEvidenceOnly(null)).toMatchObject({
      kind: "absent",
      vaultAuthority: false,
      certWeakening: false,
    });
  });
});

describe("PEER pairing + export", () => {
  it("pairs with limited delegations and round-trips encrypted export/QR", async () => {
    const kp = await generatePeerKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const reg = new PeerPairingRegistry();
    const paired = reg.pair({
      peerRef: "peer-1",
      origin: "https://peer.example/duress",
      recipientPrincipalRef: "alice",
      recipientPublicKeyJwk: jwk,
      consentedAt: new Date().toISOString(),
      delegations: [
        {
          operation: "quarantine_device",
          vaultRef: "v1",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    });
    expect(
      reg.assertDelegation("peer-1", "quarantine_device", "v1").generation,
    ).toBe(1);
    expect(() => reg.assertDelegation("peer-1", "mint_root", "v1")).toThrow();

    const wrap = await generatePeerWrapKey();
    const blob = await exportPeerPairing(paired, wrap, 60_000);
    const imported = await importPeerPairing(blob, wrap);
    expect(imported.peerRef).toBe("peer-1");
    expect(peerExportToQrSvg(blob)).toContain("<svg");

    reg.revoke("peer-1", new Date().toISOString());
    expect(() =>
      reg.assertDelegation("peer-1", "quarantine_device", "v1"),
    ).toThrow(/revoked/);
  });
});
