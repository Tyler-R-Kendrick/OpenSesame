import { WrongPasswordError, bytesToB64 } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { PrfCeremonyError } from "./protection/adapters/webauthn-prf-output.js";
import * as factor from "./unlock-factor-crypto.js";
import * as legacy from "./unlock-methods.js";

const raw = crypto.getRandomValues(new Uint8Array(32));

it("keeps PRF domain/salt wrapping and typed refusal through public wrappers", async () => {
  const prf = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(prf));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = new ArrayBuffer(16);
  const userId = new ArrayBuffer(16);
  const record = await legacy.wrapVaultKeyWithPrf(
    raw,
    prf,
    salt,
    credentialId,
    userId,
  );
  expect(record.prfSaltB64).toBe(bytesToB64(salt));
  expect(record.credentialIdB64).toBe(bytesToB64(new Uint8Array(credentialId)));
  const opened = await factor.unwrapVaultKeyWithPrf(record, prf);
  expect(opened).toEqual(raw);
  opened.fill(0);
  const wrong = prf.slice(0);
  new Uint8Array(wrong)[0] ^= 1;
  await expect(
    factor.unwrapVaultKeyWithPrf(record, wrong),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  await expect(
    factor.wrapVaultKeyWithPrf(
      raw,
      new ArrayBuffer(31),
      salt,
      credentialId,
      userId,
    ),
  ).rejects.toBeInstanceOf(PrfCeremonyError);
  new Uint8Array(prf).fill(0);
  new Uint8Array(wrong).fill(0);
});

it("retains exact passkey credential selection without a preference or ceremony", async () => {
  const prf = new ArrayBuffer(32);
  crypto.getRandomValues(new Uint8Array(prf));
  const record = await factor.wrapVaultKeyWithPrf(
    raw,
    prf,
    new Uint8Array(32),
    new ArrayBuffer(16),
    new ArrayBuffer(16),
  );
  const peer = { ...record, credentialIdB64: btoa("second-test-credential") };
  const unlocks = { passkey: record, passkeys: [peer] };
  expect(factor.listPasskeyUnlockRecords(unlocks)).toEqual([record, peer]);
  expect(factor.findPasskeyUnlockRecord(unlocks, peer.credentialIdB64)).toBe(
    peer,
  );
  expect(factor.findPasskeyUnlockRecord(unlocks, btoa("absent"))).toBeNull();
  expect(legacy.listPasskeyUnlockRecords).toBe(factor.listPasskeyUnlockRecords);
  new Uint8Array(prf).fill(0);
});
