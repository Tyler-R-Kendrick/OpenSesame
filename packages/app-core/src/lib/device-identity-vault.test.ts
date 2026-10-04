/**
 * What the device host reads of the vault (ADR 0160), from the real vfs and
 * the plaintext pointers — no store import.
 */

/** @vitest-environment jsdom */
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import { deviceVaultView } from "./device-identity-vault.js";
import { kvDeleteDurable, kvSetDurable } from "./kv.js";
import { LAST_VAULT_KEY } from "./last-vault.js";
import { GUEST_TOMB, lockAllTombs, unlockTomb } from "./vfs.js";

afterEach(async () => {
  lockAllTombs();
  await kvDeleteDurable(LAST_VAULT_KEY);
});

describe("deviceVaultView", () => {
  it("is none on a device no vault has ever been opened on", () => {
    expect(deviceVaultView()).toEqual({ kind: "none" });
  });

  it("is locked once the device remembers a vault and none is open", async () => {
    await kvSetDurable(LAST_VAULT_KEY, "personal");
    expect(deviceVaultView()).toEqual({ kind: "locked" });
  });

  it("is locked, not none, for a guest that locked", async () => {
    await kvSetDurable(LAST_VAULT_KEY, GUEST_TOMB);
    expect(deviceVaultView()).toEqual({ kind: "locked" });
  });

  it("names the open tomb, and calls the guest tomb a guest", async () => {
    unlockTomb(GUEST_TOMB, (await mintVaultKey()).vaultKey);
    expect(deviceVaultView()).toEqual({
      kind: "unlocked",
      tomb: GUEST_TOMB,
      guest: true,
    });
  });

  it("calls the personal tomb a member's", async () => {
    unlockTomb("personal", (await mintVaultKey()).vaultKey);
    expect(deviceVaultView()).toEqual({
      kind: "unlocked",
      tomb: "personal",
      guest: false,
    });
  });
});
