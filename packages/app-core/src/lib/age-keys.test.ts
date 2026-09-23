import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGE_KEYS_CONFIG_PATH,
  appendGeneratedAgeIdentity,
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

  it("validates recipients and identities via age-encryption parse", async () => {
    const pair = await generateAgeKeyPair();
    expect(isAgeRecipient(pair.recipient)).toBe(true);
    expect(isAgeIdentity(pair.identity)).toBe(true);
    expect(isAgeRecipient("not-a-recipient")).toBe(false);
    expect(isAgeRecipient("age1ql3z7hjy9example")).toBe(false);
    expect(isAgeIdentity("age1ql3z7hjy9example")).toBe(false);
    expect(
      isAgeIdentity(
        "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
      ),
    ).toBe(false);
    // SSH recipients are not accepted by age-encryption@0.3.1 Encrypter.
    expect(isAgeRecipient("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI")).toBe(false);
  });

  it("mints a pair and round-trips ciphertext with typage", async () => {
    const pair = await generateAgeKeyPair();
    const plain = new TextEncoder().encode("hello-age");
    const cipher = await encryptWithAge(plain, [pair.recipient]);
    const out = await decryptWithAge(cipher, pair.identity);
    expect(new TextDecoder().decode(out)).toBe("hello-age");
    expect(
      await proveAgeKeyRoundTrip({
        recipients: [pair.recipient],
        identity: pair.identity,
        identities: [],
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
    expect(saved.identities).toHaveLength(1);
    expect(saved.identities[0]?.recipient).toBe(pair.recipient);
    expect(saved.identities[0]?.custody).toBe("vault-sealed");

    const loaded = await readAgeKeyConfig(PERSONAL_TOMB);
    expect(loaded.identity).toBe(saved.identity);
    expect(loaded.identities).toHaveLength(1);
    expect(loaded.identities[0]?.id).toBe(saved.identities[0]?.id);
  });

  it("appending a generated identity preserves the prior inventory (KP-25)", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const first = await appendGeneratedAgeIdentity(PERSONAL_TOMB);
    expect(first.identities).toHaveLength(1);
    const firstId = first.identities[0]?.id;
    const firstIdentity = first.identities[0]?.identity;
    expect(firstId).toBeTruthy();
    expect(firstIdentity).toBeTruthy();

    const second = await appendGeneratedAgeIdentity(PERSONAL_TOMB);
    expect(second.identities).toHaveLength(2);
    expect(second.identities.some((row) => row.id === firstId)).toBe(true);
    expect(
      second.identities.some((row) => row.identity === firstIdentity),
    ).toBe(true);
    // writeAgeKeyConfig merge path used by AgeKeysPanel also preserves.
    const thirdPair = await generateAgeKeyPair();
    const merged = await writeAgeKeyConfig(PERSONAL_TOMB, {
      recipients: [...second.recipients, thirdPair.recipient],
      identity: thirdPair.identity,
    });
    expect(merged.identities.length).toBeGreaterThanOrEqual(3);
    expect(
      merged.identities.some((row) => row.identity === firstIdentity),
    ).toBe(true);
  });
});
