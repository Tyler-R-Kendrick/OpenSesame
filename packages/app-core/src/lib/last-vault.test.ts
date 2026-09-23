import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet } from "./kv.js";
import {
  LAST_VAULT_KEY,
  lastVaultIsGuest,
  readLastVaultId,
  writeLastVaultId,
} from "./last-vault.js";
import { GUEST_TOMB } from "./vfs.js";

describe("last-vault", () => {
  beforeEach(() => {
    kvDelete(LAST_VAULT_KEY);
  });

  it("remembers guest as the last authorized vault", () => {
    expect(readLastVaultId()).toBeNull();
    expect(lastVaultIsGuest()).toBe(false);
    writeLastVaultId(GUEST_TOMB);
    expect(readLastVaultId()).toBe(GUEST_TOMB);
    expect(lastVaultIsGuest()).toBe(true);
    expect(kvGet(LAST_VAULT_KEY)).toBe(GUEST_TOMB);
  });

  it("ignores blank ids", () => {
    writeLastVaultId("  ");
    expect(readLastVaultId()).toBeNull();
  });
});
