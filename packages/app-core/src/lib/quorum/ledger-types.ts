/**
 * What a ledger reports: the outcome of a submission, the state of its
 * request, what it can be saved as, and the plain-data verdict other code acts
 * on without importing the ledger.
 */

import type { Approval, Cancellation, Operation, Release } from "./types.js";

export type Outcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: string; message: string }>;

export type LedgerStatus =
  | Readonly<{ state: "cancelled" }>
  | Readonly<{ state: "expired" }>
  | Readonly<{ state: "collecting"; approved: number; closesAt: string }>
  | Readonly<{ state: "approval_closed" }>
  | Readonly<{ state: "waiting"; releasableAt: string }>
  | Readonly<{ state: "releasable"; until: string }>
  | Readonly<{ state: "complete" }>
  /** An action-only request whose quorum has approved and whose delay has passed. */
  | Readonly<{ state: "authorized"; until: string }>
  /** The authorized action has been carried out, once. */
  | Readonly<{ state: "executed" }>;

export type LedgerSnapshot = Readonly<{
  approvals: readonly Approval[];
  releases: readonly Release[];
  counters: Readonly<Record<string, number>>;
  spent: readonly string[];
  cancellation: Cancellation | null;
  executed: boolean;
}>;

/**
 * What the ledger says about its request, as plain data, so the code that
 * acts on it can prove "a quorum approved this" without importing the ledger.
 */
export type LedgerVerdict = Readonly<{
  state: LedgerStatus["state"];
  operation: Operation;
  circleId: string;
  requestDigest: string;
  approvedBy: readonly string[];
  validUntil: string;
}>;
