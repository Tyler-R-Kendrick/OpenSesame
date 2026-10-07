import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import {
  deviceConnectorPrincipalFromState,
  notifyDeviceConnectorPrincipalTransfer,
} from "../device-connector-principal-state.js";
import { enqueueVfsWrite } from "../vfs-write-queue.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  authenticateTombRootGeneration,
  pinTombAuthority,
  refreshTombRootGeneration,
  writePlaintextFile,
} from "../vfs.js";
import { headerCarriesGate } from "./header-gate.js";
import { noteMasterWrap, wrapMoved } from "./master-wrap.js";
import { reconcileLegacyRecords } from "./protection/legacy-sync.js";
import { authenticationHeaderWitness } from "./store-auth-header.js";
import { readTombHeader } from "./store-header.js";
import { pinStoredRootAuthority } from "./store-root-authority.js";
import type { VaultState } from "./store-state.js";
import { withBodyWriteLock } from "./vault-shared-locks.js";

export function requireUnlockedVault(
  key: CryptoKey | null,
  header: VaultHeader | null,
) {
  assertNotDecoySession();
  if (!key || !header)
    throw new Error("Unlock the vault before changing unlock methods.");
  return { vaultKey: key, header };
}

type HeaderPersistenceHost = {
  tomb: string;
  previous: VaultHeader | null;
  next: VaultHeader;
  assertCurrent(): void;
  assignHeader(header: VaultHeader | null): void;
  committed(): void;
  emit(): void;
  masterWrap?: {
    ephemeral?(): boolean;
    body(): VaultBody;
    root(): readonly [key: CryptoKey | null, raw: () => Uint8Array];
    mutate(change: (body: VaultBody) => void): Promise<void>;
  };
};

export async function persistStoreHeader(
  host: HeaderPersistenceHost,
): Promise<void> {
  host.assertCurrent();
  const originalRoot = host.masterWrap?.root();
  const originalKey = originalRoot?.[0];
  const raw = originalKey && originalRoot ? originalRoot[1]().slice() : null;
  try {
    const firstEphemeralHeader = isFirstEphemeralHeader(host, originalKey);
    const keyGuard = originalKey ? pinTombAuthority(host.tomb) : () => {};
    await withBodyWriteLock(host.tomb, async () => {
      host.assertCurrent();
      keyGuard();
      if (originalKey && raw)
        await proveHeaderRoot(host, originalKey, raw, keyGuard);
      await commitHeader(host, firstEphemeralHeader, keyGuard);
    });
    host.assertCurrent();
    host.committed();
    host.emit();
    host.assertCurrent();
    const carry = host.masterWrap;
    if (carry?.root()[0] && wrapMoved(host.previous, host.next, carry.body())) {
      await carry.mutate((body) => {
        host.assertCurrent();
        noteMasterWrap(body, host.next);
      });
      host.assertCurrent();
    }
  } finally {
    raw?.fill(0);
  }
}

/** Finish authoritative wrap projection before admitting transferred metadata. */
export async function persistStoreHeaderWithConnectorTransfer(
  host: HeaderPersistenceHost & {
    snapshot(): VaultState;
    project(): Promise<void>;
  },
): Promise<void> {
  host.assertCurrent();
  const original = deviceConnectorPrincipalFromState(host.snapshot());
  await persistStoreHeader(host);
  host.assertCurrent();
  if (original?.kind === "guest" || needsProjection(host.snapshot().header)) {
    await host.project();
    host.assertCurrent();
    if (needsProjection(host.snapshot().header))
      throw new Error(
        "Vault authentication projection could not be completed.",
      );
  }
  await notifyDeviceConnectorPrincipalTransfer(original, host.snapshot());
  host.assertCurrent();
}

function needsProjection(header: VaultHeader | null): boolean {
  return (
    !!header?.protection &&
    reconcileLegacyRecords(header, header.protection) !== null
  );
}

async function proveHeaderRoot(
  host: HeaderPersistenceHost,
  key: CryptoKey,
  raw: Uint8Array,
  guard: () => void,
): Promise<void> {
  try {
    pinTombAuthority(host.tomb, key)();
  } catch {
    await authenticateTombRootGeneration(host.tomb, key, raw, () => {
      host.assertCurrent();
      guard();
    });
  }
  host.assertCurrent();
  guard();
  pinStoredRootAuthority(host.tomb, key)();
}

async function commitHeader(
  host: HeaderPersistenceHost,
  firstEphemeralHeader: boolean,
  keyGuard: () => void,
): Promise<void> {
  await enqueueVfsWrite(host.tomb, async () => {
    host.assertCurrent();
    keyGuard();
    const current = readTombHeader(host.tomb);
    if (
      !(firstEphemeralHeader && current === null) &&
      authenticationHeaderWitness(current) !==
        authenticationHeaderWitness(host.previous)
    )
      throw new Error("Vault authentication changed before the header commit.");
    const next = { ...host.next, bodyRev: current?.bodyRev };
    host.assignHeader(next);
    try {
      await writePlaintextFile(host.tomb, HEADER_PATH, JSON.stringify(next));
      host.assertCurrent();
    } catch (error) {
      host.assertCurrent();
      host.assignHeader(host.previous);
      host.emit();
      throw error;
    }
    const key = host.masterWrap?.root()[0];
    if (key) {
      try {
        refreshTombRootGeneration(host.tomb, key);
      } catch {
        // Independently imported, already-proven roots retain the same IDs.
        pinStoredRootAuthority(host.tomb, key)();
      }
    }
    keyGuard();
  });
}

function isFirstEphemeralHeader(
  host: HeaderPersistenceHost,
  key: CryptoKey | null | undefined,
): boolean {
  return (
    !!key &&
    host.masterWrap?.ephemeral?.() === true &&
    host.tomb === GUEST_TOMB &&
    !!host.previous &&
    !host.previous.protection &&
    !headerCarriesGate(host.previous)
  );
}
