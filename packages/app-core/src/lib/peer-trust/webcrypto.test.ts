import { describe, expect, it, vi } from "vitest";
import { bytesToB64, sha256Hex, signP256, verifyP256 } from "./webcrypto.js";

describe("peer trust WebCrypto byte boundaries", () => {
  it("accepts offset inputs and refuses shared inputs without copying", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const data = new Uint8Array([0, 1, 2, 0]).subarray(1, 3);
    const spki = bytesToB64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const signature = await signP256(pair.privateKey, data);
    expect(signature).not.toBeNull();
    if (signature === null) throw new Error("signature missing");
    expect(await verifyP256(spki, signature, data)).toBe(true);
    expect(await sha256Hex(data)).toMatch(/^[a-f0-9]{64}$/);
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set(data);
    Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(2) });
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      await expect(sha256Hex(shared)).rejects.toThrow(TypeError);
      expect(digest).not.toHaveBeenCalled();
      expect(await signP256(pair.privateKey, shared)).toBeNull();
      expect(await verifyP256(spki, signature, shared)).toBe(false);
    } finally {
      digest.mockRestore();
    }
  });
});
