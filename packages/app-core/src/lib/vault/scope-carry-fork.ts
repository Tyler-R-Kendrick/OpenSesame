/**
 * Fork an unlocked vault into the active project tomb (shared device key).
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { carryProjectsViewInto, projectsState } from "../projects.js";
import {
  HEADER_PATH,
  refreshTombRootGeneration,
  unlockTomb,
  writePlaintextFile,
} from "../vfs.js";

type VaultScope = Readonly<{ tomb: string; attempts: string }>;

export async function carryForkUnlockedIntoActiveScope(input: {
  pinContext: (allowKeyAdmission?: boolean) => () => void;
  vaultKey: CryptoKey | null;
  header: VaultHeader | null;
  ephemeral: boolean;
  scope: VaultScope;
  sessionRootDigest: () => Promise<string | null>;
  assignScope: (scope: VaultScope) => void;
  assignHeader: (header: VaultHeader) => void;
  assignBody: () => void;
  clearPendingVaultKey: () => void;
  persistPrefs: () => void;
  persist: () => Promise<void>;
  touch: () => void;
  armIdleTimer: () => void;
  emit: () => void;
  nextScope: () => VaultScope;
}): Promise<void> {
  const assertOriginal = input.pinContext();
  if (!input.vaultKey || !input.header) {
    throw new Error("Unlock the vault before carrying it into a new project.");
  }
  if (input.ephemeral) {
    throw new Error("A guest session has no key to share.");
  }
  const { assertCompartmentSwitchAllowed } = await import(
    "../duress/store/compartment-guard.js"
  );
  assertOriginal();
  const nextScope = input.nextScope();
  const digest = await input.sessionRootDigest();
  assertOriginal();
  assertCompartmentSwitchAllowed({
    sourceTomb: input.scope.tomb,
    targetTomb: nextScope.tomb,
    mode: "fork",
    sessionRootDigest: digest,
    ephemeral: input.ephemeral,
  });
  input.assignScope(nextScope);
  unlockTomb(nextScope.tomb, input.vaultKey);
  const header: VaultHeader = {
    v: 1,
    createdAt: new Date().toISOString(),
  };
  if (input.header.kdf) header.kdf = input.header.kdf;
  if (input.header.wrap) header.wrap = input.header.wrap;
  if (input.header.unlocks) header.unlocks = { ...input.header.unlocks };
  if (input.header.hint) header.hint = input.header.hint;
  input.assignHeader(header);
  input.assignBody();
  input.clearPendingVaultKey();
  const assertCurrent = input.pinContext();
  await writePlaintextFile(nextScope.tomb, HEADER_PATH, JSON.stringify(header));
  assertCurrent();
  refreshTombRootGeneration(nextScope.tomb, input.vaultKey);
  input.persistPrefs();
  await input.persist();
  assertCurrent();
  await carryProjectsViewInto(nextScope.tomb, projectsState(), assertCurrent);
  assertCurrent();
  input.touch();
  input.armIdleTimer();
  input.emit();
}
