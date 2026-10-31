import { runInNewContext } from "node:vm";
import { overlapCast } from "@opensesame/os-domain";
import { bytesToB64url } from "@opensesame/sdk-browser";
import { expect, it, vi } from "vitest";
import { resizableArrayBuffer } from "./__tests__/resizable-array-buffer.js";
import { applySignInPrf, installSignInPrfVault } from "./local-passkey-prf.js";

type PrfResultFixture =
  | ArrayBuffer
  | SharedArrayBuffer
  | { byteLength: number }
  | null;

function fixture(first: PrfResultFixture, matched = true) {
  const rawId = new Uint8Array([1, 2]).buffer;
  const salt = new Uint8Array(32).fill(3);
  const id = bytesToB64url(rawId);
  const credential: PublicKeyCredential = overlapCast({
    id,
    rawId,
    getClientExtensionResults: () => ({ prf: { results: { first } } }),
  });
  const plan = new Map([
    [matched ? id : "unmatched", { salt, existing: false }],
  ]);
  return { credential, plan, salt };
}

it("wipes an otherwise valid result when there is no matching plan row", async () => {
  const bytes = new Uint8Array(32).fill(7);
  const f = fixture(bytes.buffer, false);
  await expect(
    applySignInPrf("tomb", "person", f.credential, f.plan),
  ).resolves.toBe(false);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(f.salt.every((byte) => byte === 0)).toBe(true);
});

it("wipes a short result and returns unsupported", async () => {
  const bytes = new Uint8Array(4).fill(7);
  const f = fixture(bytes.buffer);
  await expect(
    applySignInPrf("tomb", "person", f.credential, f.plan),
  ).resolves.toBe(false);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  expect(f.salt.every((byte) => byte === 0)).toBe(true);
});

it("reads the first result once and assesses and wipes that same result", async () => {
  const short = new Uint8Array(4).fill(7);
  const later = new Uint8Array(32).fill(8);
  const f = fixture(null);
  let reads = 0;
  const results = {
    get first() {
      return ++reads === 1 ? short.buffer : later.buffer;
    },
  };
  f.credential.getClientExtensionResults = overlapCast(() => ({
    prf: { results },
  }));
  await expect(
    applySignInPrf("tomb", "person", f.credential, f.plan),
  ).resolves.toBe(false);
  expect(reads).toBe(1);
  expect(short.every((byte) => byte === 0)).toBe(true);
  expect(later.every((byte) => byte === 8)).toBe(true);
  expect(f.salt.every((byte) => byte === 0)).toBe(true);
});

it("rejects shared and fake PRF buffers without modifying caller memory", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(32)).fill(9);
  const fake = { byteLength: 32 };
  for (const first of [shared.buffer, fake]) {
    const f = fixture(first);
    await expect(
      applySignInPrf("tomb", "person", f.credential, f.plan),
    ).resolves.toBe(false);
    expect(f.salt.every((byte) => byte === 0)).toBe(true);
  }
  expect(shared.every((byte) => byte === 9)).toBe(true);
});

it("rejects an already detached PRF buffer and wipes salts", async () => {
  const bytes = new Uint8Array(32).fill(7);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  const f = fixture(bytes.buffer);
  await expect(
    applySignInPrf("tomb", "person", f.credential, f.plan),
  ).resolves.toBe(false);
  expect(f.salt.every((byte) => byte === 0)).toBe(true);
});

it("accepts and wipes a cross-realm ArrayBuffer", async () => {
  const first: ArrayBuffer = runInNewContext(
    "new Uint8Array(32).fill(7).buffer",
  );
  const f = fixture(first);
  await expect(
    applySignInPrf("tomb", "person", f.credential, f.plan),
  ).resolves.toBe(true);
  expect(new Uint8Array(first).every((byte) => byte === 0)).toBe(true);
  expect(f.salt.every((byte) => byte === 0)).toBe(true);
});

it("cleans up salts and fails closed if the result is detached during vault lookup", async () => {
  const bytes = new Uint8Array(32).fill(7);
  const f = fixture(bytes.buffer);
  const isUnlocked = vi.fn(() => {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return false;
  });
  const release = installSignInPrfVault(
    overlapCast({ isUnlocked, activeTomb: () => "tomb", protection: {} }),
  );
  try {
    await expect(
      applySignInPrf("tomb", "person", f.credential, f.plan),
    ).rejects.toThrow();
    expect(isUnlocked).toHaveBeenCalledOnce();
    expect(f.salt.every((byte) => byte === 0)).toBe(true);
  } finally {
    release();
  }
});

it.each(["extension", "first"])(
  "wipes salts if the %s getter throws",
  async (which) => {
    const f = fixture(null);
    if (which === "extension") {
      f.credential.getClientExtensionResults = overlapCast(() => {
        throw new Error("bad extension");
      });
    } else {
      f.credential.getClientExtensionResults = overlapCast(() => ({
        prf: {
          results: {
            get first() {
              throw new Error("bad first");
            },
          },
        },
      }));
    }
    await expect(
      applySignInPrf("tomb", "person", f.credential, f.plan),
    ).rejects.toThrow();
    expect(f.salt.every((byte) => byte === 0)).toBe(true);
  },
);

it("wipes only the original PRF range when a resizable result grows during vault lookup", async () => {
  const resizable = resizableArrayBuffer(32, 64);
  const first = resizable.buffer;
  new Uint8Array(first).fill(7);
  const f = fixture(first);
  const release = installSignInPrfVault(
    overlapCast({
      isUnlocked: () => {
        resizable.resize(64);
        new Uint8Array(first, 32).fill(9);
        return false;
      },
      activeTomb: () => "tomb",
      protection: {},
    }),
  );
  try {
    await expect(
      applySignInPrf("tomb", "person", f.credential, f.plan),
    ).resolves.toBe(true);
    expect(new Uint8Array(first, 0, 32).every((byte) => byte === 0)).toBe(true);
    expect(new Uint8Array(first, 32).every((byte) => byte === 9)).toBe(true);
    expect(f.salt.every((byte) => byte === 0)).toBe(true);
  } finally {
    release();
  }
});

it("fails closed and wipes salts when a resizable result shrinks during vault lookup", async () => {
  const resizable = resizableArrayBuffer(32, 64);
  const first = resizable.buffer;
  new Uint8Array(first).fill(7);
  const f = fixture(first);
  const release = installSignInPrfVault(
    overlapCast({
      isUnlocked: () => {
        resizable.resize(8);
        return false;
      },
      activeTomb: () => "tomb",
      protection: {},
    }),
  );
  try {
    await expect(
      applySignInPrf("tomb", "person", f.credential, f.plan),
    ).rejects.toThrow();
    expect(new Uint8Array(first).every((byte) => byte === 0)).toBe(true);
    expect(f.salt.every((byte) => byte === 0)).toBe(true);
  } finally {
    release();
  }
});
