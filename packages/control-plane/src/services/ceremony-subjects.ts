/**
 * Identity-owned ceremony rows for device, pairing, and transaction subjects.
 *
 * Host-plane effects still ride the outbox. These rows are the records consume
 * mutates so a spent approval is observable as a real session/grant/result,
 * not only an unpublished command (ADR 0125, F05, X-05).
 */

import {
  type DeviceAuthorizationSession,
  type InteractionKind,
  approveDeviceAuth,
  consumeDeviceAuth,
} from "@opensesame/os-domain";

export interface OwnedDeviceSession {
  readonly ownerPrincipalId: string;
  readonly session: DeviceAuthorizationSession;
}

export type PairingState = "pending" | "paired" | "revoked" | "expired";

export interface PairingSession {
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly state: PairingState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly pairedAt?: Date;
  readonly pairedByPrincipalId?: string;
}

export type TransactionState = "pending" | "authorized" | "failed" | "expired";

export interface TransactionAuthorizationRecord {
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly state: TransactionState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly authorizedAt?: Date;
  readonly authorizedByPrincipalId?: string;
  readonly resourceRef?: string;
}

export interface CeremonySubjectStore {
  getDevice(id: string): OwnedDeviceSession | undefined;
  putDevice(row: OwnedDeviceSession): void;
  getPairing(id: string): PairingSession | undefined;
  putPairing(row: PairingSession): void;
  getTransaction(id: string): TransactionAuthorizationRecord | undefined;
  putTransaction(row: TransactionAuthorizationRecord): void;
}

const EMPTY_DIGEST = new Uint8Array(32);

export function newOwnedDevice(
  id: string,
  ownerPrincipalId: string,
  now: Date,
): OwnedDeviceSession {
  return {
    ownerPrincipalId,
    session: {
      id,
      clientId: "interaction",
      deviceCodeDigest: EMPTY_DIGEST,
      userCodeDigest: EMPTY_DIGEST,
      requestedScopes: [],
      requestedResources: [],
      state: "pending",
      intervalSeconds: 5,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      pollCount: 0,
    },
  };
}

export function newPairingSession(
  id: string,
  ownerPrincipalId: string,
  now: Date,
): PairingSession {
  return {
    id,
    ownerPrincipalId,
    state: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
  };
}

export function newTransactionRecord(
  id: string,
  ownerPrincipalId: string,
  now: Date,
): TransactionAuthorizationRecord {
  return {
    id,
    ownerPrincipalId,
    state: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
  };
}

/** Test and RFC 8628 adapters seed an entitled row; create never auto-mints. */
export function seedCeremonySubject(
  store: CeremonySubjectStore,
  kind: InteractionKind,
  subjectId: string,
  ownerPrincipalId: string,
  now: Date,
): void {
  if (kind === "device_authorization") {
    if (!store.getDevice(subjectId)) {
      store.putDevice(newOwnedDevice(subjectId, ownerPrincipalId, now));
    }
    return;
  }
  if (kind === "pairing") {
    if (!store.getPairing(subjectId)) {
      store.putPairing(newPairingSession(subjectId, ownerPrincipalId, now));
    }
    return;
  }
  if (kind === "transaction_authorization") {
    if (!store.getTransaction(subjectId)) {
      store.putTransaction(
        newTransactionRecord(subjectId, ownerPrincipalId, now),
      );
    }
  }
}

export function consumeOwnedDevice(
  row: OwnedDeviceSession,
  approverPrincipalId: string,
  now: Date,
): OwnedDeviceSession {
  if (row.session.state === "consumed") return row;
  const approved =
    row.session.state === "approved"
      ? row.session
      : approveDeviceAuth(row.session, approverPrincipalId, now);
  return {
    ownerPrincipalId: row.ownerPrincipalId,
    session: consumeDeviceAuth(approved, now),
  };
}

export function pairSession(
  row: PairingSession,
  pairedByPrincipalId: string,
  now: Date,
): PairingSession {
  if (row.state !== "pending") return row;
  return {
    ...row,
    state: "paired",
    pairedAt: now,
    pairedByPrincipalId,
  };
}

export function authorizeTransaction(
  row: TransactionAuthorizationRecord,
  authorizedByPrincipalId: string,
  now: Date,
  resourceRef?: string,
): TransactionAuthorizationRecord {
  if (row.state !== "pending") return row;
  const authorized = {
    ...row,
    state: "authorized" as const,
    authorizedAt: now,
    authorizedByPrincipalId,
  };
  if (resourceRef) {
    authorized.resourceRef = resourceRef;
  }
  return authorized;
}

export function createMemoryCeremonySubjectStore(): CeremonySubjectStore {
  const devices = new Map<string, OwnedDeviceSession>();
  const pairings = new Map<string, PairingSession>();
  const transactions = new Map<string, TransactionAuthorizationRecord>();
  return {
    getDevice: (id) => devices.get(id),
    putDevice: (row) => {
      devices.set(row.session.id, row);
    },
    getPairing: (id) => pairings.get(id),
    putPairing: (row) => {
      pairings.set(row.id, row);
    },
    getTransaction: (id) => transactions.get(id),
    putTransaction: (row) => {
      transactions.set(row.id, row);
    },
  };
}
