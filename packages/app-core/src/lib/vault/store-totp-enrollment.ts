/** TOTP enrollment and self-registration retain their original store authority. */
import type { VaultBody, VaultHeader, VaultItem } from "@opensesame/vault-core";
import {
  UnguardedTotpEnrollment,
  proveTotpEnrollment,
  startTotpEnrollment,
  withSelfAuthenticatorRegistration,
} from "./self-authenticator.js";
import { type TotpGateRecord, primaryUnlockCount } from "./unlock-methods.js";
export async function confirmSessionTotpEnrollment(input: {
  header: VaultHeader;
  vaultKey: CryptoKey;
  ephemeral: boolean;
  secret: string | null;
  code: string;
  assertCurrent(): void;
  persist(header: VaultHeader): Promise<void>;
  register(gate: TotpGateRecord): Promise<void>;
  clearSecret(): void;
}): Promise<void> {
  input.assertCurrent();
  try {
    const gate = await proveTotpEnrollment({
      ephemeral: input.ephemeral,
      primaryCount: primaryUnlockCount(input.header),
      secret: input.secret,
      code: input.code,
      vaultKey: input.vaultKey,
    });
    input.assertCurrent();
    await input.persist({
      ...input.header,
      unlocks: { ...input.header.unlocks, totp: gate },
    });
    input.assertCurrent();
    await input.register(gate);
    input.assertCurrent();
  } catch (error) {
    input.assertCurrent();
    if (error instanceof UnguardedTotpEnrollment) input.clearSecret();
    throw error;
  }
  input.clearSecret();
}
export async function registerSessionSelfAuthenticator(input: {
  header: VaultHeader;
  vaultKey: CryptoKey;
  body: VaultBody;
  gate: TotpGateRecord;
  assertCurrent(): void;
  persist(header: VaultHeader): Promise<void>;
  save(item: VaultItem): Promise<void>;
}): Promise<void> {
  input.assertCurrent();
  const next = await withSelfAuthenticatorRegistration(
    input.vaultKey,
    input.gate,
    input.header,
    input.body,
  );
  input.assertCurrent();
  if (next.item) {
    await input.save(next.item);
    input.assertCurrent();
  }
  await input.persist(next.header);
  input.assertCurrent();
}

export function startSessionTotpEnrollment(
  ephemeral: boolean,
  header: VaultHeader,
) {
  return startTotpEnrollment(ephemeral, primaryUnlockCount(header));
}
