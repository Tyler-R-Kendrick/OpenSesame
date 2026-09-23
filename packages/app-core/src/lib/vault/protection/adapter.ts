/**
 * Adapter contracts and opaque root handles (C03).
 * Handles must never be JSON-serialized.
 */

import type {
  ProtectionContext,
  ProtectionRecord,
  ProtectorAvailability,
  VerificationEvidence,
} from "@opensesame/vault-core";
import { ProtectionError } from "./errors.js";

const HANDLE_BRAND = Symbol("ClientRootKeyHandle");

export type ClientRootKeyHandle = {
  readonly [HANDLE_BRAND]: true;
  readonly context: ProtectionContext;
  readonly bytes: Uint8Array;
};

export function mintRootKeyHandle(
  context: ProtectionContext,
  bytes: Uint8Array,
): ClientRootKeyHandle {
  return { [HANDLE_BRAND]: true, context, bytes };
}

type MaybeRootHandle = {
  readonly [HANDLE_BRAND]?: true;
  readonly context?: ProtectionContext;
  readonly bytes?: Uint8Array;
};

export function isRootKeyHandle(
  value: ClientRootKeyHandle | MaybeRootHandle | null,
): value is ClientRootKeyHandle {
  if (value === null) return false;
  if (!(HANDLE_BRAND in value)) return false;
  // SAFETY: HANDLE_BRAND presence checked; brand value confirms mintRootKeyHandle.
  return value[HANDLE_BRAND] === true;
}

export function disposeRootKeyHandle(handle: ClientRootKeyHandle): void {
  handle.bytes.fill(0);
}

export type AuthorizedEnrollmentRequest = {
  operationId: string;
  sessionGeneration: number;
  context: ProtectionContext;
  rootHandle: ClientRootKeyHandle;
  signal?: AbortSignal | undefined;
};

export type AuthorizedProofRequest = {
  operationId: string;
  sessionGeneration: number;
  context: ProtectionContext;
  record: ProtectionRecord;
  signal?: AbortSignal | undefined;
};

export type AuthorizedOpenRequest = {
  operationId: string;
  sessionGeneration: number;
  context: ProtectionContext;
  record: ProtectionRecord;
  signal?: AbortSignal | undefined;
};

export type PendingProtection = {
  record: ProtectionRecord;
  proof: ProtectionProof;
};

export type ProtectionProof = {
  ok: true;
  evidence: VerificationEvidence;
};

export interface KeyProtectorAdapter {
  capabilities(): ProtectorAvailability;
  enroll(request: AuthorizedEnrollmentRequest): Promise<PendingProtection>;
  prove(request: AuthorizedProofRequest): Promise<ProtectionProof>;
  open(request: AuthorizedOpenRequest): Promise<ClientRootKeyHandle>;
  dispose(): Promise<void>;
}

export function assertNotCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProtectionError("canceled", "Operation was canceled.");
  }
}

export function assertSessionGeneration(
  expected: number,
  actual: number,
): void {
  if (expected !== actual) {
    throw new ProtectionError(
      "stale_operation",
      "Session generation changed; discarding stale protection operation.",
    );
  }
}
