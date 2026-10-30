import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { bytesToB64, sha256Hex, signP256, verifyP256 } from "./webcrypto.js";

describe("peer trust WebCrypto byte boundaries", () => {
  it("performs sign and verify with cross-realm offset views", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const foreign = runInNewContext(
      "new Uint8Array([9, 1, 2, 9]).subarray(1, 3)",
    );
    const spki = bytesToB64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const signature = await signP256(pair.privateKey, foreign);
    expect(signature).not.toBeNull();
    if (signature === null) throw new Error("signature missing");
    expect(await verifyP256(spki, signature, foreign)).toBe(true);
    expect(await sha256Hex(foreign)).toBe(
      await sha256Hex(new Uint8Array([1, 2])),
    );
  });
  it("refuses already-detached views rather than treating them as empty", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const spki = bytesToB64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const emptySignature = await signP256(pair.privateKey, new Uint8Array());
    expect(emptySignature).not.toBeNull();
    if (emptySignature === null) throw new Error("signature missing");
    const detached = new Uint8Array([1, 2]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await expect(sha256Hex(detached)).rejects.toThrow(TypeError);
    expect(await signP256(pair.privateKey, detached)).toBeNull();
    expect(await verifyP256(spki, emptySignature, detached)).toBe(false);
  });
  it("refuses an out-of-bounds resized view instead of verifying empty bytes", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const spki = bytesToB64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const emptySignature = await signP256(pair.privateKey, new Uint8Array());
    expect(emptySignature).not.toBeNull();
    if (emptySignature === null) throw new Error("signature missing");
    const buffer = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
    const payload = new Uint8Array(buffer, 0, 4);
    Reflect.apply(Reflect.get(buffer, "resize"), buffer, [0]);
    await expect(sha256Hex(payload)).rejects.toThrow(TypeError);
    expect(await signP256(pair.privateKey, payload)).toBeNull();
    expect(await verifyP256(spki, emptySignature, payload)).toBe(false);
  });
  it("refuses a payload detached while the verification key imports", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const spki = bytesToB64(
      new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
    );
    const emptySignature = await signP256(pair.privateKey, new Uint8Array());
    expect(emptySignature).not.toBeNull();
    if (emptySignature === null) throw new Error("signature missing");
    const payload = new Uint8Array([1, 2]);
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    const importing = vi
      .spyOn(crypto.subtle, "importKey")
      .mockImplementationOnce(async (...args) => {
        const key = await Reflect.apply(original, crypto.subtle, args);
        structuredClone(payload.buffer, { transfer: [payload.buffer] });
        return key;
      });
    try {
      expect(await verifyP256(spki, emptySignature, payload)).toBe(false);
    } finally {
      importing.mockRestore();
    }
  });
  it("refuses a payload detached while signing is in flight", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const payload = new Uint8Array([1, 2]);
    const original = crypto.subtle.sign.bind(crypto.subtle);
    const signing = vi
      .spyOn(crypto.subtle, "sign")
      .mockImplementationOnce(async (...args) => {
        const signature = await Reflect.apply(original, crypto.subtle, args);
        structuredClone(payload.buffer, { transfer: [payload.buffer] });
        return signature;
      });
    try {
      expect(await signP256(pair.privateKey, payload)).toBeNull();
    } finally {
      signing.mockRestore();
    }
  });

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
