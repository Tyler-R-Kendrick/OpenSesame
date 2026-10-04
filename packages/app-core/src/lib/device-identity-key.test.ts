/**
 * The device identity key (ADR 0160): sealed in the vault, minted once,
 * its thumbprint the principal, and never trusted when it lies.
 */

/** @vitest-environment jsdom */
import { ecP256JwkThumbprint } from "@opensesame/siop-v2";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceIdentityKeyError,
  ensureDeviceIdentityKey,
  p256JwkThumbprint,
} from "./device-identity-key.js";
import {
  VfsError,
  lockTomb,
  readFile,
  readSealedFile,
  unlockTomb,
  writeFile,
} from "./vfs.js";

const PATH = "config/device-identity-key";

async function openTomb(): Promise<string> {
  const tomb = `device-key-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  return tomb;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureDeviceIdentityKey", () => {
  it("mints on first use and reads the same key back", async () => {
    const tomb = await openTomb();
    const first = await ensureDeviceIdentityKey(tomb);
    const second = await ensureDeviceIdentityKey(tomb);
    expect(second).toEqual(first);
    expect(first.principalId).toBe(`prn_${first.keyId}`);
    expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(JSON.stringify(first)).not.toMatch(/"d"|privateJwk/);
  });

  it("derives the key id as the RFC 7638 thumbprint, as siop-v2 computes it", async () => {
    const tomb = await openTomb();
    const key = await ensureDeviceIdentityKey(tomb);
    expect(await p256JwkThumbprint(key.publicJwk)).toBe(key.keyId);
    expect(await ecP256JwkThumbprint({ ...key.publicJwk, alg: "ES256" })).toBe(
      key.keyId,
    );
  });

  it("keeps a different key in each tomb", async () => {
    const a = await ensureDeviceIdentityKey(await openTomb());
    const b = await ensureDeviceIdentityKey(await openTomb());
    expect(a.principalId).not.toBe(b.principalId);
  });

  it("seals the private half: the stored blob names no key material", async () => {
    const tomb = await openTomb();
    const key = await ensureDeviceIdentityKey(tomb);
    const blob = JSON.stringify(readSealedFile(tomb, PATH));
    expect(blob).not.toBe("null");
    expect(blob).not.toContain("privateJwkJson");
    expect(blob).not.toContain(key.publicJwk.x);
    // Opened through the VFS it holds the private scalar, and only there.
    const opened = new TextDecoder().decode(await readFile(tomb, PATH));
    expect(opened).toContain("privateJwkJson");
  });

  it("mints exactly one key when callers race", async () => {
    const tomb = await openTomb();
    const keys = await Promise.all(
      Array.from({ length: 6 }, () => ensureDeviceIdentityKey(tomb)),
    );
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
  });

  it("takes the shared Web Lock when the browser has one", async () => {
    const request = vi.fn(
      async <T>(_name: string, run: () => Promise<T>): Promise<T> => run(),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const tomb = await openTomb();
    await ensureDeviceIdentityKey(tomb);
    expect(request).toHaveBeenCalledWith(
      `opensesame-device-identity-${tomb}`,
      expect.any(Function),
    );
  });

  it("fails locked while the vault is shut, and mints nothing", async () => {
    const tomb = await openTomb();
    lockTomb(tomb);
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
      code: "locked",
    });
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toBeInstanceOf(
      VfsError,
    );
  });

  it("refuses a record whose key id is not its public key's thumbprint", async () => {
    const tomb = await openTomb();
    const key = await ensureDeviceIdentityKey(tomb);
    const stored = JSON.parse(
      new TextDecoder().decode(await readFile(tomb, PATH)),
    );
    stored.keyId = "A".repeat(43);
    await writeFile(
      tomb,
      PATH,
      new TextEncoder().encode(JSON.stringify(stored)),
    );
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toBeInstanceOf(
      DeviceIdentityKeyError,
    );
    expect(key.keyId).not.toBe(stored.keyId);
  });

  it("refuses a record it cannot parse rather than minting over it", async () => {
    const tomb = await openTomb();
    await writeFile(tomb, PATH, new TextEncoder().encode('{"version":2}'));
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toBeInstanceOf(
      DeviceIdentityKeyError,
    );
  });
});
