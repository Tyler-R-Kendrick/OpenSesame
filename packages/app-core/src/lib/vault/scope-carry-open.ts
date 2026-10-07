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

type PreviousCarry = {
  scope: VaultScope;
  header: VaultHeader;
  body: VaultBody;
};

type CarryInput = {
  cancelPendingOps: () => void;
  pinContext: (allowKeyAdmission?: boolean) => () => void;
  vaultKey: CryptoKey | null;
  header: VaultHeader | null;
  ephemeral: boolean;
  scope: VaultScope;
  body: VaultBody;
  sessionRootDigest: () => Promise<string | null>;
  lockHandlers: readonly (() => void)[];
  activateSession: (
    vaultKey: CryptoKey,
    assertCurrent: () => void,
  ) => Promise<void>;
  assignScope: (scope: VaultScope) => void;
  assignHeader: (header: VaultHeader) => void;
  assignBody: (body: VaultBody) => void;
  assignVaultKey: (key: CryptoKey) => void;
  emit: () => void;
  nextScope: () => VaultScope;
};

export async function carryOpenActiveScopeWithCurrentKey(
  input: CarryInput,
): Promise<void> {
  input.cancelPendingOps();
  const assertOriginal = input.pinContext();
  const vaultKey = input.vaultKey;
  if (!vaultKey || !input.header || input.ephemeral) {
    throw new Error("Unlock the vault before carrying it into another.");
  }
  const { assertCompartmentSwitchAllowed } = await import(
    "../duress/store/compartment-guard.js"
  );
  assertOriginal();
  const next = input.nextScope();
  const digest = await input.sessionRootDigest();
  assertOriginal();
  assertCompartmentSwitchAllowed({
    sourceTomb: input.scope.tomb,
    targetTomb: next.tomb,
    mode: "open",
    sessionRootDigest: digest,
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
  for (const handler of input.lockHandlers) {
    handler();
    assertOriginal();
  }
  emitVaultLock();
  assertOriginal();
  lockTomb(previous.scope.tomb);
  discardTombCaches();
  input.assignScope(next);
  input.assignHeader(header);
  input.assignBody(emptyBody());
  const assertCurrent = input.pinContext(true);
  try {
    await input.activateSession(vaultKey, assertCurrent);
    assertCurrent();
  } catch (error) {
    assertCurrent();
    await restorePreviousCarry(input, previous, vaultKey, next);
    throw error instanceof VaultCorruptError
      ? new Error("That vault was sealed with a different key.")
      : error;
  }
  assertCurrent();
  await carryProjectsViewInto(next.tomb, previous.projects, assertCurrent);
  assertCurrent();
}

async function restorePreviousCarry(
  input: CarryInput,
  previous: PreviousCarry,
  vaultKey: CryptoKey,
  next: VaultScope,
): Promise<void> {
  lockTomb(next.tomb);
  input.assignScope(previous.scope);
  input.assignHeader(previous.header);
  input.assignBody(previous.body);
  input.assignVaultKey(vaultKey);
  unlockTomb(previous.scope.tomb, vaultKey);
  const assertRollback = input.pinContext();
  await hydrateAndMigrateTombOnUnlock(
    previous.scope.tomb,
    assertRollback,
  ).catch(() => undefined);
  assertRollback();
  input.emit();
}
