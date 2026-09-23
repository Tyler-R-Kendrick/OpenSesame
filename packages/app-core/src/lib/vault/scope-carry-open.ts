/**
 * Carry an unlocked vault key into another project tomb (ADR 0089).
 */

import {
  type VaultBody,
  VaultCorruptError,
  type VaultHeader,
  emptyBody,
} from "@opensesame/vault-core";
import { carryProjectsViewInto, projectsState } from "../projects.js";
import { BODY_PATH, lockTomb, readSealedFile, unlockTomb } from "../vfs.js";
import { emitVaultLock } from "./lock-events.js";
import { readTombHeader, sharesWrapRecord } from "./store-header.js";
import {
  discardTombCaches,
  hydrateAndMigrateTombOnUnlock,
} from "./tomb-migration.js";

type VaultScope = Readonly<{ tomb: string; attempts: string }>;

export async function carryOpenActiveScopeWithCurrentKey(input: {
  cancelPendingOps: () => void;
  vaultKey: CryptoKey | null;
  header: VaultHeader | null;
  ephemeral: boolean;
  scope: VaultScope;
  body: VaultBody;
  sessionRootDigest: () => string | null;
  lockHandlers: readonly (() => void)[];
  activateSession: (vaultKey: CryptoKey) => Promise<void>;
  assignScope: (scope: VaultScope) => void;
  assignHeader: (header: VaultHeader) => void;
  assignBody: (body: VaultBody) => void;
  assignVaultKey: (key: CryptoKey) => void;
  emit: () => void;
  nextScope: () => VaultScope;
}): Promise<void> {
  input.cancelPendingOps();
  const vaultKey = input.vaultKey;
  if (!vaultKey || !input.header || input.ephemeral) {
    throw new Error("Unlock the vault before carrying it into another.");
  }
  const { assertCompartmentSwitchAllowed } = await import(
    "../duress/store/compartment-guard.js"
  );
  const next = input.nextScope();
  assertCompartmentSwitchAllowed({
    sourceTomb: input.scope.tomb,
    targetTomb: next.tomb,
    mode: "open",
    sessionRootDigest: input.sessionRootDigest(),
    ephemeral: input.ephemeral,
  });
  const header = readTombHeader(next.tomb);
  if (!header) {
    throw new Error("That vault has not been sealed yet.");
  }
  if (
    readSealedFile(next.tomb, BODY_PATH) === null &&
    !sharesWrapRecord(input.header, header)
  ) {
    throw new Error("That vault was sealed with a different key.");
  }
  const previous = {
    scope: input.scope,
    header: input.header,
    body: input.body,
    projects: projectsState(),
  };
  for (const handler of input.lockHandlers) handler();
  emitVaultLock();
  lockTomb(previous.scope.tomb);
  discardTombCaches();
  input.assignScope(next);
  input.assignHeader(header);
  input.assignBody(emptyBody());
  try {
    await input.activateSession(vaultKey);
  } catch (error) {
    lockTomb(next.tomb);
    input.assignScope(previous.scope);
    input.assignHeader(previous.header);
    input.assignBody(previous.body);
    input.assignVaultKey(vaultKey);
    unlockTomb(previous.scope.tomb, vaultKey);
    await hydrateAndMigrateTombOnUnlock(previous.scope.tomb).catch(
      () => undefined,
    );
    input.emit();
    throw error instanceof VaultCorruptError
      ? new Error("That vault was sealed with a different key.")
      : error;
  }
  await carryProjectsViewInto(next.tomb, previous.projects);
}
