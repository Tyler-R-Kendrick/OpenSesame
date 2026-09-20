import { afterEach, describe, expect, it } from "vitest";
import {
  AGE_KEYS_CONFIG_PATH,
  decryptWithAge,
  encryptWithAge,
  generateAgeKeyPair,
  isAgeIdentity,
  isAgeRecipient,
  proveAgeKeyRoundTrip,
  readAgeKeyConfig,
  writeAgeKeyConfig,
} from "./age-keys.js";
import { kvDelete } from "./kv.js";
import { mintVaultKey } from "./vault/crypto.js";
import {
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

describe("age-keys (typage)", () => {
  afterEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, AGE_KEYS_CONFIG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, "index"));
    kvDelete(TOMBS_REGISTRY_KEY);
  });

  it("recognizes age recipient and identity lines", () => {
    expect(isAgeRecipient("age1ql3z7hjy9example")).toBe(true);
    expect(isAgeRecipient("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI")).toBe(true);
    expect(isAgeRecipient("not-a-recipient")).toBe(false);
    expect(
      isAgeIdentity(
        "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
      ),
    ).toBe(true);
    expect(isAgeIdentity("age1ql3z7hjy9example")).toBe(false);
  });

  it("mints a pair and round-trips ciphertext with typage", async () => {
    const pair = await generateAgeKeyPair();
    expect(isAgeIdentity(pair.identity)).toBe(true);
    expect(isAgeRecipient(pair.recipient)).toBe(true);

    const plain = new TextEncoder().encode("hello-age");
    const cipher = await encryptWithAge(plain, [pair.recipient]);
    const out = await decryptWithAge(cipher, pair.identity);
    expect(new TextDecoder().decode(out)).toBe("hello-age");
    expect(
      await proveAgeKeyRoundTrip({
        recipients: [pair.recipient],
        identity: pair.identity,
      }),
    ).toBe(true);
  });

  it("seals recipients and identity in the vault VFS", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const pair = await generateAgeKeyPair();
    const saved = await writeAgeKeyConfig(PERSONAL_TOMB, {
      recipients: [pair.recipient],
      identity: pair.identity,
    });
    expect(saved.recipients).toEqual([pair.recipient]);
    expect(saved.identity).toBe(pair.identity);

    const loaded = await readAgeKeyConfig(PERSONAL_TOMB);
    expect(loaded).toEqual(saved);
  });
});
