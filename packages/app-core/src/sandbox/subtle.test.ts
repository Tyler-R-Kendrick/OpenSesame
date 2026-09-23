import { describe, expect, it } from "vitest";
import { sandboxSubtle } from "./subtle.js";

const te = new TextEncoder();
const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");

describe("sandbox SubtleCrypto matches WebCrypto", () => {
  it("derives the same PBKDF2 and HKDF bits", async () => {
    const salt = bytes(16, 1);
    const password = te.encode("correct horse");
    const pbkdf2 = { name: "PBKDF2", salt, iterations: 1000, hash: "SHA-256" };
    const ours = await sandboxSubtle.deriveBits(
      pbkdf2,
      await sandboxSubtle.importKey("raw", password, "PBKDF2", false, [
        "deriveBits",
      ]),
      256,
    );
    const theirs = await crypto.subtle.deriveBits(
      pbkdf2,
      await crypto.subtle.importKey("raw", password, "PBKDF2", false, [
        "deriveBits",
      ]),
      256,
    );
    expect(hex(ours)).toBe(hex(theirs));

    const hkdf = {
      name: "HKDF",
      salt,
      info: te.encode("info"),
      hash: "SHA-256",
    };
    const ikm = bytes(32, 7);
    expect(
      hex(
        await sandboxSubtle.deriveBits(
          hkdf,
          await sandboxSubtle.importKey("raw", ikm, "HKDF", false, [
            "deriveBits",
          ]),
          256,
        ),
      ),
    ).toBe(
      hex(
        await crypto.subtle.deriveBits(
          hkdf,
          await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
            "deriveBits",
          ]),
          256,
        ),
      ),
    );
  });

  it("seals AES-GCM with additional data interchangeably with WebCrypto", async () => {
    const raw = bytes(32, 3);
    const params = {
      name: "AES-GCM",
      iv: bytes(12, 9),
      additionalData: te.encode("aad"),
    };
    const ours = await sandboxSubtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    const theirs = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    const plain = te.encode("sealed body");
    const sealed = await sandboxSubtle.encrypt(params, ours, plain);
    expect(hex(sealed)).toBe(
      hex(await crypto.subtle.encrypt(params, theirs, plain)),
    );
    expect(
      new Uint8Array(await crypto.subtle.decrypt(params, theirs, sealed)),
    ).toEqual(plain);
    const tampered = new Uint8Array(sealed);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(
      sandboxSubtle.decrypt(params, ours, tampered),
    ).rejects.toMatchObject({
      name: "OperationError",
    });
    await expect(
      sandboxSubtle.decrypt(
        { ...params, additionalData: te.encode("other") },
        ours,
        sealed,
      ),
    ).rejects.toMatchObject({ name: "OperationError" });
  });

  it("derives an AES key the way deriveKey does", async () => {
    const pbkdf2 = {
      name: "PBKDF2",
      salt: bytes(16, 2),
      iterations: 500,
      hash: "SHA-256",
    };
    const password = te.encode("pw");
    const params = { name: "AES-GCM", iv: bytes(12, 4) };
    const ours = await sandboxSubtle.deriveKey(
      pbkdf2,
      await sandboxSubtle.importKey("raw", password, "PBKDF2", false, [
        "deriveKey",
      ]),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const theirs = await crypto.subtle.deriveKey(
      pbkdf2,
      await crypto.subtle.importKey("raw", password, "PBKDF2", false, [
        "deriveKey",
      ]),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const plain = te.encode("x");
    expect(hex(await sandboxSubtle.encrypt(params, ours, plain))).toBe(
      hex(await crypto.subtle.encrypt(params, theirs, plain)),
    );
  });

  it("digests and signs as WebCrypto does, and verifies in constant shape", async () => {
    const data = te.encode("message");
    expect(hex(await sandboxSubtle.digest("SHA-256", data))).toBe(
      hex(await crypto.subtle.digest("SHA-256", data)),
    );
    const hmac = { name: "HMAC", hash: "SHA-256" };
    const raw = bytes(32, 5);
    const ours = await sandboxSubtle.importKey("raw", raw, hmac, false, [
      "sign",
      "verify",
    ]);
    const theirs = await crypto.subtle.importKey("raw", raw, hmac, false, [
      "sign",
    ]);
    const signature = await sandboxSubtle.sign("HMAC", ours, data);
    expect(hex(signature)).toBe(
      hex(await crypto.subtle.sign("HMAC", theirs, data)),
    );
    expect(await sandboxSubtle.verify("HMAC", ours, signature, data)).toBe(
      true,
    );
    expect(
      await sandboxSubtle.verify("HMAC", ours, signature.slice(1), data),
    ).toBe(false);
  });

  it("refuses what it does not implement and guards key bytes", async () => {
    await expect(
      sandboxSubtle.digest("SHA-1", new Uint8Array()),
    ).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    await expect(
      sandboxSubtle.importKey("jwk", new Uint8Array(), "AES-GCM", false, []),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    const hidden = await sandboxSubtle.importKey(
      "raw",
      bytes(32, 1),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    expect(Object.keys(hidden).sort()).toEqual([
      "algorithm",
      "extractable",
      "type",
      "usages",
    ]);
    await expect(sandboxSubtle.exportKey("raw", hidden)).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    await expect(
      sandboxSubtle.decrypt(
        { name: "AES-GCM", iv: bytes(12, 0) },
        hidden,
        bytes(32, 0),
      ),
    ).rejects.toMatchObject({ name: "InvalidAccessError" });
  });
});
