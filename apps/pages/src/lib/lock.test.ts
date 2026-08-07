import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "./kv.js";
import {
  hasUnlockPin,
  isUnlocked,
  lock,
  setUnlockPin,
  unlock,
} from "./lock.js";

beforeEach(() => {
  lock();
  kvDelete("unlockHash.v1");
  kvDelete("unlockAttempts.v1");
});

describe("unlock PIN", () => {
  it("rejects short PINs", async () => {
    await expect(setUnlockPin("12345")).rejects.toThrow(/at least 6/);
    expect(hasUnlockPin()).toBe(false);
  });

  it("stores salted PBKDF2 (not bare SHA-256 hex)", async () => {
    await setUnlockPin("correct-horse");
    expect(isUnlocked()).toBe(true);
    const raw = kvGet("unlockHash.v1");
    expect(raw).toBeTruthy();
    expect(raw).not.toMatch(/^[0-9a-f]{64}$/i);
    const parsed = JSON.parse(raw!) as {
      v: number;
      salt: string;
      hash: string;
      iterations: number;
    };
    expect(parsed.v).toBe(1);
    expect(parsed.salt.length).toBeGreaterThan(8);
    expect(parsed.hash).toHaveLength(64);
    expect(parsed.iterations).toBeGreaterThanOrEqual(100_000);
  });

  it("unlocks with the correct PIN and rejects wrong ones", async () => {
    await setUnlockPin("vault-pin-ok");
    lock();
    expect(isUnlocked()).toBe(false);
    await expect(unlock("wrong-pin!!!!")).rejects.toThrow(/did not match/);
    await unlock("vault-pin-ok");
    expect(isUnlocked()).toBe(true);
  });

  it("upgrades legacy unsalted SHA-256 on successful unlock", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("legacy-pin"),
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    kvSet("unlockHash.v1", hex);
    lock();
    await unlock("legacy-pin");
    const upgraded = JSON.parse(kvGet("unlockHash.v1")!) as { v: number };
    expect(upgraded.v).toBe(1);
  });

  it("locks out after repeated failed unlocks", async () => {
    await setUnlockPin("vault-pin-ok");
    lock();
    await expect(unlock("wrong-pin-aaaa")).rejects.toThrow(/did not match/);
    await expect(unlock("wrong-pin-bbbb")).rejects.toThrow(/did not match/);
    await expect(unlock("wrong-pin-cccc")).rejects.toThrow(/did not match/);
    await expect(unlock("vault-pin-ok")).rejects.toThrow(/Too many unlock attempts/);
    const attempts = JSON.parse(kvGet("unlockAttempts.v1")!) as {
      fails: number;
      lockedUntil: number;
    };
    expect(attempts.fails).toBeGreaterThanOrEqual(3);
    expect(attempts.lockedUntil).toBeGreaterThan(Date.now());
  });
});
