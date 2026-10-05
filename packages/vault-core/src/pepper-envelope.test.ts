import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import type { PepperSealPbkdf2 } from "./account.js";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import { PBKDF2_ITERATIONS, VaultCorruptError } from "./crypto.js";
import { gcmOpen, gcmSeal } from "./gcm.js";
import {
  WrongPepperError,
  openWithPepper,
  pepperBinding,
  sealWithPepper,
} from "./pepper-seal.js";

async function keyOf(seal: PepperSealPbkdf2): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("pepper"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: overlapCast(b64ToBytes(seal.kdf.saltB64)),
      iterations: seal.kdf.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aad(seal: PepperSealPbkdf2, binding: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "pepper-envelope",
      seal.v,
      binding,
      seal.kdf.alg,
      seal.kdf.saltB64,
      seal.kdf.iterations,
      seal.seal.ivB64,
    ]),
  );
}

async function unwrapped(
  seal: PepperSealPbkdf2,
  binding: string,
): Promise<Uint8Array> {
  const frame = b64ToBytes(seal.seal.ctB64);
  return gcmOpen(
    await keyOf(seal),
    frame.subarray(0, 12),
    frame.subarray(12, 60),
    aad(seal, binding),
  );
}

const binding = pepperBinding("account", "method");

describe("pepper envelope v2", () => {
  it("wraps independently random DEKs and cannot decrypt the payload with the pepper KEK", async () => {
    const a = await sealWithPepper("password", "pepper", binding);
    const b = await sealWithPepper("password", "pepper", binding);
    expect(a.v).toBe(2);
    const first = await unwrapped(a, binding);
    const second = await unwrapped(b, binding);
    expect(first.length).toBe(32);
    expect(first).not.toEqual(second);
    const frame = b64ToBytes(a.seal.ctB64);
    const payloadAad = new Uint8Array(aad(a, binding).length + 60);
    payloadAad.set(aad(a, binding));
    payloadAad.set(frame.subarray(0, 60), aad(a, binding).length);
    await expect(
      gcmOpen(
        await keyOf(a),
        b64ToBytes(a.seal.ivB64),
        frame.subarray(60),
        payloadAad,
      ),
    ).rejects.toThrow();
    const replacementIv = new Uint8Array(12).fill(99);
    const replacementWrap = await gcmSeal(
      await keyOf(a),
      first,
      replacementIv,
      aad(a, binding),
    );
    const replaced = frame.slice();
    replaced.set(replacementIv, 0);
    replaced.set(replacementWrap, 12);
    await expect(
      openWithPepper(
        { ...a, seal: { ...a.seal, ctB64: bytesToB64(replaced) } },
        "pepper",
        binding,
      ),
    ).rejects.toBeInstanceOf(WrongPepperError);
    first.fill(0);
    second.fill(0);
  });

  it("rejects every header component, payload tampering and version downgrade", async () => {
    const sealed = await sealWithPepper("password", "pepper", binding);
    for (const position of [0, 12, 59, 60, 75]) {
      const bytes = b64ToBytes(sealed.seal.ctB64);
      bytes[position] = (bytes[position] ?? 0) ^ 1;
      await expect(
        openWithPepper(
          { ...sealed, seal: { ...sealed.seal, ctB64: bytesToB64(bytes) } },
          "pepper",
          binding,
        ),
      ).rejects.toBeInstanceOf(WrongPepperError);
    }
    await expect(
      openWithPepper({ ...sealed, v: 1 }, "pepper", binding),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      openWithPepper(
        {
          ...sealed,
          seal: { ...sealed.seal, ctB64: bytesToB64(new Uint8Array(75)) },
        },
        "pepper",
        binding,
      ),
    ).rejects.toBeInstanceOf(WrongPepperError);
    await expect(
      openWithPepper(
        { ...sealed, kdf: { ...sealed.kdf, saltB64: "AA==" } },
        "pepper",
        binding,
      ),
    ).rejects.toBeInstanceOf(VaultCorruptError);
  });

  it("uses unambiguous account/method bindings even with embedded delimiters", async () => {
    const a = pepperBinding("account\u0000part", "method");
    const b = pepperBinding("account", "part\u0000method");
    expect(a).not.toBe(b);
    const sealed = await sealWithPepper("password", "pepper", a);
    await expect(openWithPepper(sealed, "pepper", b)).rejects.toBeInstanceOf(
      WrongPepperError,
    );
  });

  it("reads an authentic legacy direct seal with the old binding and refuses ambiguous conversion", async () => {
    const sealed: PepperSealPbkdf2 = {
      v: 1,
      kdf: {
        alg: "PBKDF2-SHA256",
        saltB64: bytesToB64(new Uint8Array(16).fill(7)),
        iterations: PBKDF2_ITERATIONS,
      },
      seal: { ivB64: bytesToB64(new Uint8Array(12).fill(8)), ctB64: "" },
    };
    sealed.seal.ctB64 = bytesToB64(
      await gcmSeal(
        await keyOf(sealed),
        new TextEncoder().encode("legacy password"),
        b64ToBytes(sealed.seal.ivB64),
        new TextEncoder().encode("pepper-seal\u0000account\u0000method"),
      ),
    );
    expect(await openWithPepper(sealed, "pepper", binding)).toBe(
      "legacy password",
    );
    await expect(
      openWithPepper(
        sealed,
        "pepper",
        pepperBinding("account\u0000part", "method"),
      ),
    ).rejects.toBeInstanceOf(WrongPepperError);
  });
});
