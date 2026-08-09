import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "./kv.js";
import {
  changeUnlockPin,
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

  it("will not let a new PIN stand in for knowing the old one", async () => {
    await setUnlockPin("vault-pin-ok");
    lock();
    // Otherwise a lockout is escaped by simply choosing a new PIN.
    await expect(setUnlockPin("attacker-pin")).rejects.toThrow(/current PIN/);
    expect(isUnlocked()).toBe(false);
    await expect(unlock("attacker-pin")).rejects.toThrow(/did not match/);
    // A re-key that proves the current PIN is fine.
    await changeUnlockPin("vault-pin-ok", "vault-pin-two");
    lock();
    await unlock("vault-pin-two");
    expect(isUnlocked()).toBe(true);
  });

  it("does not derive at a cost a stored record chose for it", async () => {
    // Too cheap: accepted once so nobody is locked out, then rewritten at today's cost.
    const cheapSalt = "AAAAAAAAAAAAAAAAAAAAAA==";
    const salt = Uint8Array.from(atob(cheapSalt), (ch) => ch.charCodeAt(0));
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("cheap-pin-ok"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: 1,
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );
    const hash = [...new Uint8Array(bits)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    kvSet(
      "unlockHash.v1",
      JSON.stringify({ v: 1, salt: cheapSalt, iterations: 1, hash }),
    );
    lock();
    await unlock("cheap-pin-ok");
    const rewritten = JSON.parse(kvGet("unlockHash.v1")!) as {
      iterations: number;
    };
    expect(rewritten.iterations).toBeGreaterThanOrEqual(100_000);

    // Absurdly expensive: refused outright rather than hanging the tab.
    kvSet(
      "unlockHash.v1",
      JSON.stringify({ v: 1, salt: cheapSalt, iterations: 1e12, hash }),
    );
    lock();
    await expect(unlock("cheap-pin-ok")).rejects.toThrow(/corrupted/);

    // Unusable salt and unusable base64 are refused too.
    kvSet(
      "unlockHash.v1",
      JSON.stringify({ v: 1, salt: "AAAA", iterations: 210_000, hash }),
    );
    await expect(unlock("cheap-pin-ok")).rejects.toThrow(/corrupted/);
    kvSet(
      "unlockHash.v1",
      JSON.stringify({ v: 1, salt: "!!!!", iterations: 210_000, hash }),
    );
    await expect(unlock("cheap-pin-ok")).rejects.toThrow(/corrupted/);
  });

  it("does not let a planted deadline lock someone out for good", async () => {
    await setUnlockPin("vault-pin-ok");
    lock();
    kvSet(
      "unlockAttempts.v1",
      JSON.stringify({
        fails: 99,
        lockedUntil: Date.now() + 400 * 24 * 3600 * 1000,
      }),
    );
    // Still locked, but bounded by the policy maximum rather than the stored value.
    await expect(unlock("vault-pin-ok")).rejects.toThrow(/Try again in (\d+)s/);
    const message = await unlock("vault-pin-ok").then(
      () => "",
      (e: Error) => e.message,
    );
    const seconds = Number(/in (\d+)s/.exec(message)?.[1]);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
  });

  it("locks out after repeated failed unlocks", async () => {
    await setUnlockPin("vault-pin-ok");
    lock();
    await expect(unlock("wrong-pin-aaaa")).rejects.toThrow(/did not match/);
    await expect(unlock("wrong-pin-bbbb")).rejects.toThrow(/did not match/);
    await expect(unlock("wrong-pin-cccc")).rejects.toThrow(/did not match/);
    await expect(unlock("vault-pin-ok")).rejects.toThrow(
      /Too many unlock attempts/,
    );
    const attempts = JSON.parse(kvGet("unlockAttempts.v1")!) as {
      fails: number;
      lockedUntil: number;
    };
    expect(attempts.fails).toBeGreaterThanOrEqual(3);
    expect(attempts.lockedUntil).toBeGreaterThan(Date.now());
  });
});
