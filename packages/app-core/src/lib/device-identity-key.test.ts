/**
 * The device identity key (ADR 0160): sealed in the vault, minted once across
 * tabs under a Web Lock and never without one, its thumbprint the principal,
 * and never trusted, nor overwritten, when it cannot be read.
 */

/** @vitest-environment jsdom */
import { ecP256JwkThumbprint } from "@opensesame/siop-v2";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WebLocksDouble,
  webLocksDouble,
} from "./__tests__/web-locks-double.js";
import {
  DeviceIdentityKeyError,
  ensureDeviceIdentityKey,
  forgetDeviceIdentityKeyInFlightForTests,
  p256JwkThumbprint,
  readDeviceIdentityKey,
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

let locks: WebLocksDouble;

beforeEach(() => {
  locks = webLocksDouble();
  vi.stubGlobal("navigator", { locks });
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetDeviceIdentityKeyInFlightForTests();
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
    const opened = new TextDecoder().decode(await readFile(tomb, PATH));
    expect(opened).toContain("privateJwkJson");
  });

  it("dedupes this tab's own concurrent callers", async () => {
    const tomb = await openTomb();
    const keys = await Promise.all(
      Array.from({ length: 6 }, () => ensureDeviceIdentityKey(tomb)),
    );
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
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
});

describe("one key across tabs", () => {
  /** Two tabs: each has its own in-flight map, both share the lock and the vault. */
  async function twoTabs(tomb: string) {
    const first = ensureDeviceIdentityKey(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    const second = ensureDeviceIdentityKey(tomb);
    return Promise.all([first, second]);
  }

  it("lets exactly one of two racing tabs mint, and both hold that key", async () => {
    const tomb = await openTomb();
    const [a, b] = await twoTabs(tomb);
    expect(a.principalId).toBe(b.principalId);
    // The key both hold is the key on disk: neither returned one that lost.
    expect((await readDeviceIdentityKey(tomb))?.principalId).toBe(
      a.principalId,
    );
  });

  it("mints only inside the vault's lock, and never with two inside at once", async () => {
    const tomb = await openTomb();
    await twoTabs(tomb);
    expect(locks.requested).toEqual([
      `opensesame-device-identity-${tomb}`,
      `opensesame-device-identity-${tomb}`,
    ]);
    expect(locks.peak()).toBe(1);
  });

  it("does not take the lock to read a key that exists", async () => {
    const tomb = await openTomb();
    await ensureDeviceIdentityKey(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    const before = locks.requested.length;
    await ensureDeviceIdentityKey(tomb);
    expect(locks.requested.length).toBe(before);
  });

  it("refuses to mint with no cross-tab lock, and writes nothing", async () => {
    vi.stubGlobal("navigator", {});
    const tomb = await openTomb();
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
      name: "DeviceIdentityKeyError",
      code: "no-fence",
    });
    await expect(readFile(tomb, PATH)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("still reads a key that exists with no cross-tab lock", async () => {
    const tomb = await openTomb();
    const minted = await ensureDeviceIdentityKey(tomb);
    forgetDeviceIdentityKeyInFlightForTests();
    vi.stubGlobal("navigator", {});
    expect((await ensureDeviceIdentityKey(tomb)).keyId).toBe(minted.keyId);
  });
});

describe("a record it cannot trust", () => {
  async function plant(tomb: string, bytes: string): Promise<void> {
    await writeFile(tomb, PATH, new TextEncoder().encode(bytes));
  }

  it("refuses a record whose key id is not its public key's thumbprint, and keeps it", async () => {
    const tomb = await openTomb();
    await ensureDeviceIdentityKey(tomb);
    const stored = JSON.parse(
      new TextDecoder().decode(await readFile(tomb, PATH)),
    );
    stored.keyId = "A".repeat(43);
    const planted = JSON.stringify(stored);
    await plant(tomb, planted);
    forgetDeviceIdentityKeyInFlightForTests();
    await expect(ensureDeviceIdentityKey(tomb)).rejects.toMatchObject({
      code: "unreadable",
    });
    expect(new TextDecoder().decode(await readFile(tomb, PATH))).toBe(planted);
  });

  it("refuses an unknown version or garbage rather than minting over it", async () => {
    for (const bytes of ['{"version":2}', "not json", "{}"]) {
      const tomb = await openTomb();
      await plant(tomb, bytes);
      await expect(ensureDeviceIdentityKey(tomb)).rejects.toBeInstanceOf(
        DeviceIdentityKeyError,
      );
      expect(new TextDecoder().decode(await readFile(tomb, PATH))).toBe(bytes);
      // Not even with a lock to mint under.
      expect(locks.requested).not.toContain(
        `opensesame-device-identity-${tomb}`,
      );
    }
  });
});
