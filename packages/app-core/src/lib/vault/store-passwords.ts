/** Password header changes share the trap lock through their durable commit. */
import { type VaultHeader, createVault } from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import {
  headerWithoutPassword,
  rekeyAdmittedPasswordHeader,
  sealAdmittedPasswordHeader,
} from "./master-wrap.js";
import {
  type CodeChannel,
  type VaultUnlocks,
  hasSecondStep,
} from "./unlock-methods.js";
import { assertKeepsPrimaryUnlock } from "./unlock-methods.js";
import { withNewPassword } from "./unlock-secret-guard.js";

type PersistHeader = (header: VaultHeader) => Promise<void>;

export async function createPasswordVault(
  tomb: string,
  password: string,
  hint: string | undefined,
  persist: (
    header: VaultHeader,
    key: CryptoKey,
    raw: Uint8Array,
  ) => Promise<void>,
): Promise<void> {
  assertNotDecoySession();
  await withNewPassword(password, tomb, async () => {
    const { header, vaultKey, rawVaultKey } = await createVault(password, hint);
    try {
      await persist(header, vaultKey, rawVaultKey);
    } catch (error) {
      rawVaultKey.fill(0);
      throw error;
    }
  });
}

export async function enrollPasswordHeader(
  tomb: string,
  header: VaultHeader,
  raw: () => Uint8Array,
  password: string,
  persist: PersistHeader,
): Promise<void> {
  assertNotDecoySession();
  await withNewPassword(password, tomb, async () => {
    await persist(await sealAdmittedPasswordHeader(header, raw(), password));
  });
}

export async function changePasswordHeader(
  tomb: string,
  header: VaultHeader | null,
  current: string,
  next: string,
  hint: string | undefined,
  persist: PersistHeader,
): Promise<void> {
  assertNotDecoySession();
  if (!header) throw new Error("There is no vault to re-key.");
  if (!header.wrap || !header.kdf)
    throw new Error(
      "This vault has no master password. Add one under Unlock methods first.",
    );
  await withNewPassword(next, tomb, async () => {
    await persist(
      await rekeyAdmittedPasswordHeader(header, current, next, hint),
    );
  });
}

export async function removeUnlockHeader(
  header: VaultHeader | null,
  method: "passkey" | "pin",
  persist: PersistHeader,
): Promise<void> {
  if (!header?.unlocks?.[method]) return;
  assertKeepsPrimaryUnlock(header, method);
  const { [method]: _removed, ...rest } = header.unlocks;
  await persist({
    ...header,
    unlocks: Object.keys(rest).length ? rest : undefined,
  });
}

export async function removePasswordHeader(
  header: VaultHeader | null,
  persist: PersistHeader,
): Promise<void> {
  if (!header?.wrap) return;
  await persist(headerWithoutPassword(header));
}

/** Removing the final second factor also removes its recovery-code authority. */
export async function removeSecondStepHeader(
  header: VaultHeader | null,
  step: "totp" | CodeChannel,
  trashItem: (id: string) => Promise<void>,
  assertCurrent: () => void,
  persist: PersistHeader,
): Promise<void> {
  assertCurrent();
  if (!header?.unlocks?.[step]) return;
  if (step === "totp" && header.unlocks.totp?.selfItemId) {
    await trashItem(header.unlocks.totp.selfItemId);
    assertCurrent();
  }
  const { [step]: _removed, ...rest } = header.unlocks;
  let unlocks: VaultUnlocks = { ...rest };
  if (
    !hasSecondStep({ ...header, unlocks }) &&
    unlocks.recovery !== undefined
  ) {
    const { recovery: _codes, ...withoutCodes } = unlocks;
    unlocks = withoutCodes;
  }
  await persist({
    ...header,
    unlocks: Object.keys(unlocks).length ? unlocks : undefined,
  });
}
