/**
 * One sync pass against a tailnet drive (ADR 0143) — Enpass's client-side
 * merge, over a drive that only stores ciphertext:
 *
 *   1. read the drive's snapshot and its generation;
 *   2. merge it into the open vault (on this device, under its key);
 *   3. if the drive now lacks something this device holds, replace it,
 *      provided nobody replaced it since step 1 — otherwise start again.
 *
 * Nothing here overwrites a snapshot it could not open: a drive holding
 * another vault, or something that fails its seal, stops the pass with an
 * error instead of being replaced.
 */
import type {
  DriveSnapshotInput,
  SealedSnapshot,
  SnapshotMerge,
} from "../vault/store-merge.js";
import {
  type DriveRead,
  type DriveWrite,
  readDrive,
  writeDrive,
} from "./client.js";
import type { DrivePairing } from "./pairing.js";
import {
  type DriveSnapshot,
  buildDriveSnapshot,
  snapshotInput,
} from "./snapshot.js";

/** The slice of `VaultStore` a sync pass needs. */
export type SyncableVault = {
  mergeSnapshot(input: DriveSnapshotInput): Promise<SnapshotMerge>;
  sealedSnapshot(): Promise<SealedSnapshot>;
};

export type DriveTransport = {
  read(pairing: DrivePairing): Promise<DriveRead>;
  write(
    pairing: DrivePairing,
    expectedGeneration: number,
    snapshot: DriveSnapshot,
  ): Promise<DriveWrite>;
};

export type SyncOutcome = {
  /** This device took in changes from another. */
  pulled: boolean;
  /** This device's changes are now on the drive. */
  pushed: boolean;
  generation: number;
};

/** Passes that lose the race this many times in a row give up until the next nudge. */
export const MAX_SYNC_ATTEMPTS = 4;

export const defaultTransport: DriveTransport = {
  read: readDrive,
  write: writeDrive,
};

export async function syncOnce(
  vault: SyncableVault,
  pairing: DrivePairing,
  transport: DriveTransport = defaultTransport,
): Promise<SyncOutcome> {
  let pulled = false;
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
    const remote = await transport.read(pairing);
    if (remote.snapshot) {
      const merge = await vault.mergeSnapshot(snapshotInput(remote.snapshot));
      pulled = pulled || merge.localChanged;
      if (!merge.remoteBehind) {
        return { pulled, pushed: false, generation: remote.generation };
      }
    }
    const local = buildDriveSnapshot(await vault.sealedSnapshot());
    const written = await transport.write(pairing, remote.generation, local);
    if (written.ok) {
      return { pulled, pushed: true, generation: written.generation };
    }
  }
  throw new Error(
    "Another device kept changing the drive. Sync will try again shortly.",
  );
}
