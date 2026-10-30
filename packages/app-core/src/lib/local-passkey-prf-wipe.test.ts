import { overlapCast } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { afterEach, expect, it, vi } from "vitest";
import { applySignInPrf, installSignInPrfVault } from "./local-passkey-prf.js";
import { wrapVaultKeyWithPrf } from "./vault/unlock-methods.js";

afterEach(() => vi.restoreAllMocks());

function fixture(existing: boolean) {
  const secret = new Uint8Array(32).fill(7);
  const salt = new Uint8Array(32).fill(3);
  const rawId = new Uint8Array([1, 2]).buffer;
  const credential: PublicKeyCredential = overlapCast({
    id: bytesToB64url(rawId),
    rawId,
    getClientExtensionResults: () => ({
      prf: { results: { first: secret.buffer } },
    }),
  });
  const plan = new Map([[bytesToB64url(rawId), { salt, existing }]]);
  return { secret, salt, rawId, credential, plan };
}

it.each(["success", "failure"])(
  "wipes the held enrollment PRF copy on %s",
  async (outcome) => {
    const f = fixture(false);
    const copies: ArrayBuffer[] = [];
    const commit = vi.fn(async () => {
      const copy = copies[0];
      expect(copy && new Uint8Array(copy).every((byte) => byte === 0)).toBe(
        true,
      );
    });
    const enroll = vi.fn(async (input: { prfOutput: ArrayBuffer }) => {
      copies.push(input.prfOutput);
      expect(new Uint8Array(input.prfOutput).some((byte) => byte !== 0)).toBe(
        true,
      );
      if (outcome === "failure") throw new Error("enrollment failed");
      return { operationId: "op" };
    });
    const release = installSignInPrfVault(
      overlapCast({
        isUnlocked: () => true,
        activeTomb: () => "tomb",
        protection: {
          listProtectors: () => [],
          enrollHeldWebauthnPrf: enroll,
          commitEnrollment: commit,
        },
      }),
    );
    try {
      const operation = applySignInPrf("tomb", "person", f.credential, f.plan);
      if (outcome === "failure")
        await expect(operation).rejects.toThrow("enrollment failed");
      else await expect(operation).resolves.toBe(true);
      expect(copies).toHaveLength(1);
      const copiedPrf = copies[0];
      if (!copiedPrf) throw new Error("PRF copy not observed");
      expect(new Uint8Array(copiedPrf).every((byte) => byte === 0)).toBe(true);
      expect(f.secret.every((byte) => byte === 0)).toBe(true);
      expect(f.salt.every((byte) => byte === 0)).toBe(true);
      if (outcome === "failure") expect(commit).not.toHaveBeenCalled();
      else expect(commit).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  },
);

it.each(["success", "failure"])(
  "wipes the copied PRF after existing protector unwrap %s",
  async (outcome) => {
    const f = fixture(true);
    const root = new Uint8Array(32).fill(5);
    const record = await wrapVaultKeyWithPrf(
      root,
      f.secret.buffer,
      f.salt,
      f.rawId,
      new ArrayBuffer(2),
    );
    const protector = {
      kind: "webauthn-prf",
      credentialIdB64: record.credentialIdB64,
      saltB64: record.prfSaltB64,
      wrap:
        outcome === "failure"
          ? {
              ...record.wrap,
              ctB64: btoa(String.fromCharCode(...new Uint8Array(16))),
            }
          : record.wrap,
    };
    const copies: ArrayBuffer[] = [];
    const expected = Array.from(f.secret);
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
      const data = args[1];
      if (
        args[0] === "raw" &&
        args[2] === "HKDF" &&
        data instanceof ArrayBuffer &&
        Array.from(new Uint8Array(data)).every(
          (byte, index) => byte === expected[index],
        ) &&
        data.byteLength === expected.length
      )
        copies.push(data);
      return Reflect.apply(original, crypto.subtle, args);
    });
    const release = installSignInPrfVault(
      overlapCast({
        isUnlocked: () => true,
        activeTomb: () => "tomb",
        protection: {
          listProtectors: () => [protector],
          enrollHeldWebauthnPrf: vi.fn(),
          commitEnrollment: vi.fn(),
        },
      }),
    );
    try {
      const operation = applySignInPrf("tomb", "person", f.credential, f.plan);
      if (outcome === "failure") await expect(operation).rejects.toThrow();
      else await expect(operation).resolves.toBe(true);
      expect(copies).toHaveLength(1);
      const copiedPrf = copies[0];
      if (!copiedPrf) throw new Error("PRF copy not observed");
      expect(new Uint8Array(copiedPrf).every((byte) => byte === 0)).toBe(true);
      expect(f.secret.every((byte) => byte === 0)).toBe(true);
      expect(f.salt.every((byte) => byte === 0)).toBe(true);
    } finally {
      root.fill(0);
      release();
    }
  },
);
