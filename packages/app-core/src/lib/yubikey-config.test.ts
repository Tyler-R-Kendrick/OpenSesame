import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "./kv.js";
import { mintVaultKey } from "./vault/crypto.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";
import {
  YUBIKEY_CONFIG_PATH,
  clearYubikeyConfig,
  isYubikeyAgeRecipient,
  readYubikeyConfig,
  writeYubikeyConfig,
} from "./yubikey-config.js";

const RECIPIENT =
  "age1yubikey1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0z1x2c3v4b5n6m7";

describe("yubikey config", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, YUBIKEY_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
  });

  it("accepts age-plugin-yubikey recipients only", () => {
    expect(isYubikeyAgeRecipient(RECIPIENT)).toBe(true);
    expect(isYubikeyAgeRecipient("age1abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isYubikeyAgeRecipient("")).toBe(false);
  });

  it("seals and clears a device config under the vault key", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await expect(
      writeYubikeyConfig(PERSONAL_TOMB, { recipient: "age1notyubi" }),
    ).rejects.toThrow(/age1yubikey/);
    const saved = await writeYubikeyConfig(PERSONAL_TOMB, {
      recipient: RECIPIENT,
      slot: "9a",
      serialHint: "12345678",
      label: "Desk key",
    });
    expect(saved).toEqual({
      recipient: RECIPIENT,
      slot: "9a",
      serialHint: "12345678",
      label: "Desk key",
    });
    await expect(readYubikeyConfig(PERSONAL_TOMB)).resolves.toEqual(saved);
    await clearYubikeyConfig(PERSONAL_TOMB);
    await expect(readYubikeyConfig(PERSONAL_TOMB)).resolves.toEqual({
      recipient: "",
      slot: null,
      serialHint: null,
      label: null,
    });
  });
});
