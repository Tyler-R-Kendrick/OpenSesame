/** First-run cryptography and persistence stay bound to their originating session. */
import { type VaultHeader, mintVaultKey } from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import {
  BODY_PATH,
  HEADER_PATH,
  deletePlaintextFile,
  lockTomb,
  refreshTombRootGeneration,
  writePlaintextFile,
} from "../vfs.js";
import { wrapVaultKeyWithCeremony } from "./passkey-unlock-session.js";
import { sealAuthenticatedManifest } from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";
import { hydrateAndMigrateTombOnUnlock } from "./tomb-migration.js";
import {
  createPasskeyUnlockCeremony,
  wrapVaultKeyWithPin,
} from "./unlock-methods.js";
import { assertNewPin } from "./unlock-secret-guard.js";
export type NewVaultPersist = (
  header: VaultHeader,
  key: CryptoKey,
  raw: Uint8Array,
  assertCurrent: () => void,
) => Promise<void>;

/** A new real root has its authenticated identity before any tab can observe it. */
export async function sealNewHeader(
  header: VaultHeader,
  raw: Uint8Array,
  assertCurrent: () => void,
): Promise<VaultHeader> {
  try {
    assertCurrent();
    const { manifest } = migrateLegacyHeaderToManifest({ header });
    const protection = await sealAuthenticatedManifest(raw, manifest);
    assertCurrent();
    return { ...header, protection };
  } catch (error) {
    raw.fill(0);
    throw error;
  }
}

export async function createPinVault(
  pin: string,
  assertCurrent: () => void,
  persist: NewVaultPersist,
): Promise<void> {
  assertNotDecoySession();
  await assertNewPin(pin);
  assertCurrent();
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  try {
    assertCurrent();
    const record = await wrapVaultKeyWithPin(rawVaultKey, pin);
    assertCurrent();
    await persist(
      { v: 1, createdAt: new Date().toISOString(), unlocks: { pin: record } },
      vaultKey,
      rawVaultKey,
      assertCurrent,
    );
  } catch (error) {
    rawVaultKey.fill(0);
    throw error;
  }
}
export async function createPasskeyVault(
  signal: AbortSignal | undefined,
  assertCurrent: () => void,
  persist: NewVaultPersist,
): Promise<void> {
  assertNotDecoySession();
  if (signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  try {
    assertCurrent();
    const ceremony = await createPasskeyUnlockCeremony(undefined, signal);
    assertCurrent();
    if (signal?.aborted)
      throw new DOMException("The operation was aborted.", "AbortError");
    const record = await wrapVaultKeyWithCeremony(rawVaultKey, ceremony);
    assertCurrent();
    await persist(
      {
        v: 1,
        createdAt: new Date().toISOString(),
        unlocks: { passkey: record },
      },
      vaultKey,
      rawVaultKey,
      assertCurrent,
    );
  } catch (error) {
    rawVaultKey.fill(0);
    throw error;
  }
}
export async function persistCreatedVault(input: {
  tomb: string;
  header: VaultHeader;
  key: CryptoKey;
  assertCurrent: () => void;
  persist: () => Promise<void>;
  loadPrefs: () => Promise<void>;
  reset: () => void;
}): Promise<void> {
  try {
    input.assertCurrent();
    await writePlaintextFile(
      input.tomb,
      HEADER_PATH,
      JSON.stringify(input.header),
    );
    input.assertCurrent();
    refreshTombRootGeneration(input.tomb, input.key);
    await input.persist();
    input.assertCurrent();
    await hydrateAndMigrateTombOnUnlock(input.tomb, input.assertCurrent);
    input.assertCurrent();
    await input.loadPrefs();
    input.assertCurrent();
  } catch (error) {
    // An obsolete failure must never clear or delete a successor's vault.
    input.assertCurrent();
    await deletePlaintextFile(input.tomb, HEADER_PATH);
    input.assertCurrent();
    await deletePlaintextFile(input.tomb, BODY_PATH);
    input.assertCurrent();
    input.reset();
    lockTomb(input.tomb);
    throw error;
  }
}
