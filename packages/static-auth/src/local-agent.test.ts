import type { BoundaryValue } from "@opensesame/os-domain";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  createLocalAgentKey,
  localAgentPublicKey,
  verifyLocalAgentChallenge,
} from "./local-agent.js";

const origin = "https://iam.example.test";
const principalId = "local_00000000-0000-4000-8000-000000000001";
const challenge = (keyId: string) => ({
  nonce: "n".repeat(43),
  principalId,
  keyId,
  origin,
  expiresAt: Date.now() + 120_000,
});

describe("browser-local agent challenge proof", () => {
  it("keeps the signing key private and verifies the exact challenge", async () => {
    const key = await createLocalAgentKey();
    expect(Object.keys(key).sort()).toEqual([
      "keyId",
      "publicKey",
      "signChallenge",
    ]);
    expect(key.publicKey).not.toHaveProperty("d");
    const request = challenge(key.keyId);
    const proof = await key.signChallenge(request, origin, principalId);
    await expect(
      verifyLocalAgentChallenge(proof, request, key.publicKey),
    ).resolves.toBeUndefined();
    for (const patch of [
      { nonce: "x".repeat(43) },
      { principalId: principalId.replace(/1$/, "2") },
      { origin: "https://other.example.test" },
      { expiresAt: request.expiresAt + 1 },
    ])
      await expect(
        verifyLocalAgentChallenge(
          proof,
          { ...request, ...patch },
          key.publicKey,
        ),
      ).rejects.toThrow();
    const other = await createLocalAgentKey();
    await expect(
      verifyLocalAgentChallenge(proof, request, other.publicKey),
    ).rejects.toThrow();
    await expect(
      key.signChallenge(request, "https://other.example.test", principalId),
    ).rejects.toThrow("binding_mismatch");
    await expect(
      key.signChallenge(request, origin, principalId.replace(/1$/, "2")),
    ).rejects.toThrow("binding_mismatch");
  });

  it("refuses private, wrong-algorithm and malformed public keys", async () => {
    const key = await createLocalAgentKey();
    const invalid: BoundaryValue[] = [
      null,
      [],
      { ...key.publicKey, d: "private sentinel" },
      { ...key.publicKey, alg: "HS256" },
      { ...key.publicKey, use: "enc" },
      { ...key.publicKey, key_ops: ["sign"] },
      { ...key.publicKey, crv: "P-384" },
      { ...key.publicKey, x: "x" },
      { ...key.publicKey, jku: "https://attacker.example.test" },
    ];
    for (const value of invalid)
      await expect(localAgentPublicKey(value)).rejects.toThrow();
    await expect(
      localAgentPublicKey({
        ...key.publicKey,
        alg: "ES256",
        key_ops: ["verify"],
        ext: true,
      }),
    ).resolves.toEqual({ publicKey: key.publicKey, keyId: key.keyId });
  });

  it("refuses another protocol's signature even from the enrolled key", async () => {
    const pair = await generateKeyPair("ES256");
    const key = await localAgentPublicKey(await exportJWK(pair.publicKey));
    const request = challenge(key.keyId);
    const proof = await new CompactSign(
      new TextEncoder().encode(JSON.stringify(request)),
    )
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", kid: key.keyId })
      .sign(pair.privateKey);
    await expect(
      verifyLocalAgentChallenge(proof, request, key.publicKey),
    ).rejects.toThrow("invalid_agent_proof");
    await expect(
      verifyLocalAgentChallenge("x".repeat(8193), request, key.publicKey),
    ).rejects.toThrow("invalid_agent_proof");
  });
});
