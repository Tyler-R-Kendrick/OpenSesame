import {
  type PinUnlockRecord,
  VaultCorruptError,
  WrongPasswordError,
  importVaultKey,
  parseTotp,
  totpCode,
} from "@opensesame/vault-core";
import { beforeAll, expect, it, vi } from "vitest";
import * as factor from "./unlock-factor-crypto.js";
import * as legacy from "./unlock-methods.js";

const PIN = "48291037";
const raw = crypto.getRandomValues(new Uint8Array(32));
let pinRecord: PinUnlockRecord;
beforeAll(async () => {
  pinRecord = await factor.wrapVaultKeyWithPin(raw, PIN);
});

it("preserves public wrapper function identity and complete PIN NFKC/KDF semantics", async () => {
  expect(legacy.wrapVaultKeyWithPin).toBe(factor.wrapVaultKeyWithPin);
  expect(legacy.unwrapVaultKeyWithPin).toBe(factor.unwrapVaultKeyWithPin);
  expect(pinRecord.kdf.alg).toBe("PBKDF2-SHA256");
  expect(pinRecord.kdf.iterations).toBe(1_200_000);
  expect(factor.MIN_PIN_LENGTH).toBe(8);
  expect(factor.MAX_PIN_LENGTH).toBe(12);
  const opened = await legacy.unwrapVaultKeyWithPin(
    pinRecord,
    "４８２９１０３７",
  );
  expect(opened).toEqual(raw);
  opened.fill(0);
  await expect(
    factor.unwrapVaultKeyWithPin(pinRecord, "48291038"),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(() => factor.assertPinPolicy("12345678")).toThrow(/sequential/);
});

it("rejects invalid PIN KDF metadata before an attempted unwrap", async () => {
  const damaged = { ...pinRecord, kdf: { ...pinRecord.kdf, iterations: 0 } };
  await expect(
    factor.unwrapVaultKeyWithPin(damaged, PIN),
  ).rejects.toBeInstanceOf(VaultCorruptError);
});

it("keeps TOTP AES authentication, enrollment defaults and all three skew windows", async () => {
  const now = 1_783_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const key = await importVaultKey(raw);
    const secret = "JBSWY3DPEHPK3PXP";
    const gate = await legacy.sealTotpSecret(key, secret);
    expect(gate.digits).toBe(6);
    expect(gate.period).toBe(30);
    expect(await legacy.openTotpSecret(key, gate)).toBe(secret);
    const wrongKey = await importVaultKey(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    await expect(legacy.openTotpSecret(wrongKey, gate)).rejects.toThrow();
    for (const offset of [-1, 0, 1]) {
      const code = await totpCode(parseTotp(secret), now + offset * 30_000);
      await expect(legacy.totpCodeMatches(secret, code)).resolves.toBe(true);
    }
    const outside = await totpCode(parseTotp(secret), now + 2 * 30_000);
    await expect(legacy.totpCodeMatches(secret, outside)).resolves.toBe(false);
    await expect(legacy.totpCodeMatches(secret, "bad-code")).resolves.toBe(
      false,
    );
  } finally {
    clock.mockRestore();
  }
});

it("preserves sealed text UTF-8 without adding TOTP-style normalization", async () => {
  const key = await importVaultKey(raw);
  const text = "Receiver: owner@example.invalid — １２３";
  const sealed = await legacy.sealText(key, text);
  await expect(factor.openText(key, sealed)).resolves.toBe(text);
  expect(legacy.openText).toBe(factor.openText);
  const wrongKey = await importVaultKey(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await expect(factor.openText(wrongKey, sealed)).rejects.toThrow();
});
