/**
 * PEER-F adversarial transport / pairing / origin tests.
 */
import { describe, expect, it, vi } from "vitest";
import { type JsonObject, overlapCast } from "../json-boundary.js";
import {
  PeerPairingRegistry,
  allowCertWeakeningForTailscale,
  assertBoundedPeerPath,
  assertSafePeerOrigin,
  buildTailscaleEvidence,
  encryptPeerPayload,
  generatePeerKeyPair,
  generatePeerWrapKey,
  sendPeerEnvelope,
  signPeerEnvelope,
  signPeerReceipt,
  tailscaleGrantsVaultAuthority,
  verifyPeerEnvelope,
} from "./index.js";

describe("PEER-F origin / SSRF", () => {
  it("rejects metadata, private, userinfo, http-non-loopback", () => {
    const bad = [
      "http://169.254.169.254/",
      "https://metadata.google.internal/",
      "https://user:pass@peer.example/",
      "http://192.168.1.1/",
      "http://10.0.0.1/",
      "https://peer.example/#frag",
      "ftp://peer.example/",
    ];
    for (const o of bad) {
      expect(() => assertSafePeerOrigin(o), o).toThrow(/unapproved_route/);
    }
    expect(assertSafePeerOrigin("https://peer.example").origin).toBe(
      "https://peer.example",
    );
    expect(assertSafePeerOrigin("http://127.0.0.1:8787").hostname).toBe(
      "127.0.0.1",
    );
    expect(() => assertBoundedPeerPath("/webhook")).toThrow();
    expect(() => assertBoundedPeerPath("/v1/duress/peer/../admin")).toThrow();
    expect(assertBoundedPeerPath("/v1/duress/peer/envelope")).toBe(
      "/v1/duress/peer/envelope",
    );
  });
});

describe("PEER-F envelope adversarial", () => {
  it("rejects expiry, epoch mismatch, oversized, unbound headers, unknown alg", async () => {
    const kp = await generatePeerKeyPair();
    const wrap = await generatePeerWrapKey();
    const ct = await encryptPeerPayload(new TextEncoder().encode("{}"), wrap);
    const base = {
      issuer: "device-a",
      audience: "receiver-1",
      principalRef: "p1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      operation: "quarantine_device",
      incidentId: "i1",
      policyRevision: 2,
      keyEpoch: 3,
      nonce: "nonce-abc-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ciphertextB64: ct,
    };
    const env = await signPeerEnvelope(base, kp.privateKey);

    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        {
          audience: "receiver-1",
          permittedOperations: ["quarantine_device"],
          now: Date.now() + 120_000,
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, code: "stale_session" });

    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        {
          audience: "receiver-1",
          permittedOperations: ["quarantine_device"],
          keyEpoch: 99,
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, code: "stale_policy" });

    expect(
      await verifyPeerEnvelope(
        env,
        kp.publicKey,
        {
          audience: "receiver-1",
          permittedOperations: ["quarantine_device"],
          minPolicyRevision: 9,
        },
        new Set(),
      ),
    ).toMatchObject({ ok: false, code: "stale_policy" });

    await expect(
      signPeerEnvelope({ ...base, alg: "HS256" }, kp.privateKey),
    ).rejects.toThrow(/unknown alg/);

    await expect(
      signPeerEnvelope({ ...base, headers: { x: "1" } }, kp.privateKey),
    ).rejects.toThrow(/unbound headers/);

    const huge = new Uint8Array(20_000);
    await expect(encryptPeerPayload(huge, wrap)).rejects.toThrow(/oversized/);
  });

  it("signs receipts and refuses Tailscale as vault authority", async () => {
    const kp = await generatePeerKeyPair();
    const receipt = await signPeerReceipt(
      {
        requestNonce: "n1",
        recipientDeviceBinding: "d1",
        status: "accepted",
        at: new Date().toISOString(),
      },
      kp.privateKey,
    );
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.signatureB64.length).toBeGreaterThan(10);

    const ev = buildTailscaleEvidence({
      loginName: "user@tailnet",
      tailnetIpv4: "100.64.1.2",
      dnsName: "node.tailnet.ts.net",
    });
    expect(ev.present).toBe(true);
    expect(tailscaleGrantsVaultAuthority(ev)).toBe(false);
    expect(allowCertWeakeningForTailscale(ev)).toBe(false);
  });
});

describe("PEER-F sender bound fetch", () => {
  it("does not follow redirects / does not send unbound headers", async () => {
    const kp = await generatePeerKeyPair();
    const env = await signPeerEnvelope(
      {
        issuer: "a",
        audience: "recv",
        principalRef: "p",
        vaultRef: "v",
        deviceBindingRef: "d",
        operation: "peer_status",
        incidentId: "i",
        policyRevision: 1,
        keyEpoch: 1,
        nonce: "nonce-send-1",
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ciphertextB64: "",
      },
      kp.privateKey,
    );

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          requestNonce: env.nonce,
          recipientDeviceBinding: "d",
          status: "accepted",
          at: new Date().toISOString(),
          signatureB64: "x",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendPeerEnvelope(env, {
      registeredOrigin: "http://127.0.0.1:8787",
      audience: "recv",
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const firstCall = fetchMock.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error("expected fetch call");
    }
    const [url, init] = overlapCast<
      typeof firstCall,
      [string | URL, RequestInit | undefined]
    >(firstCall);
    expect(String(url)).toBe("http://127.0.0.1:8787/v1/duress/peer/envelope");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "accept",
      "content-type",
      "x-opensesame-duress-peer",
    ]);
    vi.unstubAllGlobals();
  });
});

describe("PEER-F pairing rotation", () => {
  it("rotation bumps generation; revoke clears delegations", async () => {
    const kp = await generatePeerKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const reg = new PeerPairingRegistry();
    reg.pair({
      peerRef: "peer-1",
      origin: "https://peer.example",
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
    const next = await generatePeerKeyPair();
    const nextJwk = await crypto.subtle.exportKey("jwk", next.publicKey);
    expect(
      reg.rotate("peer-1", nextJwk, new Date().toISOString()).generation,
    ).toBe(2);
    reg.revoke("peer-1", new Date().toISOString());
    expect(() =>
      reg.assertDelegation("peer-1", "quarantine_device", "v1"),
    ).toThrow(/revoked/);
  });
});
