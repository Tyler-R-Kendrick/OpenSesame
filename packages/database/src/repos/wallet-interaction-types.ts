/**
 * Wallet-adjacent interaction repository contracts (ADR 0086).
 */

import type {
  ApprovalMechanism,
  AssuranceLevel,
  InteractionKind,
  PrincipalId,
} from "@opensesame/os-domain";
import type { UnitOfWork } from "./interfaces.js";

/** How a proof attempt was answered. `accepted` is the one finalizing outcome. */
export type ProofAttemptOutcome =
  | "accepted"
  | "rejected_digest_mismatch"
  | "rejected_verification"
  | "rejected_assurance"
  | "rejected_expired"
  | "rejected_replayed";

/**
 * A durable record of one attempt to answer an interaction with a proof
 * (ADR 0086; findings F04, F05).
 *
 * Never carries the proof inputs (assertion/presentation/JOSE). `proofInputDigest`
 * is a digest of the input, kept only so the same proof arriving twice can be
 * recognised — the durable replacement for a process-local seen-set.
 */
export interface InteractionProofAttempt {
  id: string;
  interactionId: string;
  mechanism: ApprovalMechanism;
  outcome: ProofAttemptOutcome;
  /** Digest of the proof input. Never the input. Globally unique. */
  proofInputDigest: Uint8Array;
  /** The digest the proof claimed to bind to. */
  boundDigest?: string;
  /** The interaction's `requestDigest` at attempt time. */
  expectedDigest?: string;
  /** Non-secret handle for the key/credential that signed. */
  credentialRef?: string;
  /** Assurance the proof cleared, on an accepted attempt. */
  assurance?: AssuranceLevel;
  approverPrincipalId?: PrincipalId;
  createdAt: Date;
}

/**
 * The durable proof-attempt store (ADR 0086; findings F04, F05).
 *
 * The proof-of-approval defences — the attempt budget and the replay set —
 * used to live in process memory, which is wrong across replicas and across
 * restarts. This is the store they must read and write instead. The store
 * decides nothing about whether a proof is valid; it makes the *facts* those
 * defences depend on durable and serialized, which a single process cannot.
 */
export interface InteractionProofAttemptRepository {
  /**
   * Record an attempt, exactly once.
   *
   * The insert is the claim, and it can fail two ways, each meaning replay:
   * a duplicate `proofInputDigest` is the same proof arriving again (on any
   * interaction, in any process), and — when `outcome` is `accepted` — a
   * second accepted row for the interaction is a second finalization. Both
   * throw `ConflictError`; the caller's move is to stop, not to retry.
   */
  record(
    attempt: InteractionProofAttempt,
    uow?: UnitOfWork,
  ): Promise<InteractionProofAttempt>;
  getById(id: string): Promise<InteractionProofAttempt | null>;
  /** The accepted (finalizing) attempt for an interaction, if one exists. */
  getAcceptedForInteraction(
    interactionId: string,
  ): Promise<InteractionProofAttempt | null>;
  /** Replay lookup: has this exact proof input been recorded before? */
  findByProofInputDigest(
    digest: Uint8Array,
  ): Promise<InteractionProofAttempt | null>;
  /**
   * The durable attempt-budget read: attempts against one interaction since a
   * cutoff. A per-process counter cannot answer this; this can.
   */
  countRecentForInteraction(
    interactionId: string,
    since: Date,
  ): Promise<number>;
}

/** Where a wallet registration is in its lifecycle. */
export type WalletRegistrationStatus =
  | "active"
  | "revoked"
  | "expired"
  | "superseded";

/**
 * A wallet pass registered against an interaction subject (ADR 0086).
 *
 * Never on the authorization path — a pass carries a reference and authorizes
 * nothing — but a durable binding with a lifecycle, so a revoke revokes and a
 * re-issue supersedes rather than forking a second live pass. Carries no
 * credential: a non-secret provider object handle and a *digest* of the
 * reference the pass embeds, never the reference.
 */
export interface WalletRegistration {
  id: string;
  provider: string;
  status: WalletRegistrationStatus;
  subjectKind: InteractionKind;
  subjectId: string;
  providerObjectRef: string;
  providerSubject?: string;
  interactionId?: string;
  approverPrincipalId?: PrincipalId;
  passReferenceDigest?: Uint8Array;
  expiresAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/**
 * The wallet-registration lifecycle store (ADR 0086).
 *
 * Subject uniqueness — one active pass per provider per ceremony subject — is
 * enforced by the store, not the caller: `register` throws `ConflictError`
 * when a live slot is already held, mirroring `interactions.getBySubject`.
 */
export interface WalletRegistrationRepository {
  register(
    registration: WalletRegistration,
    uow?: UnitOfWork,
  ): Promise<WalletRegistration>;
  getById(id: string): Promise<WalletRegistration | null>;
  findActiveBySubject(
    provider: string,
    subjectKind: InteractionKind,
    subjectId: string,
  ): Promise<WalletRegistration | null>;
  findActiveByObjectRef(
    provider: string,
    providerObjectRef: string,
  ): Promise<WalletRegistration | null>;
  listForApprover(principalId: string): Promise<WalletRegistration[]>;
  /**
   * Optimistic-concurrency lifecycle transition. The patch names only the
   * fields a lifecycle move may touch; the consented-to identity of the pass
   * (provider, subject, object ref) is not among them.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: Partial<
      Pick<
        WalletRegistration,
        "status" | "revokedAt" | "expiresAt" | "providerObjectRef"
      >
    >,
    uow?: UnitOfWork,
  ): Promise<WalletRegistration>;
  /** Sweep active registrations past their expiry to `expired`. */
  expireDue(now: Date): Promise<number>;
}

/** Where an execution reservation is. */
export type ExecutionReservationStatus =
  | "held"
  | "committed"
  | "released"
  | "expired";

/**
 * A fenced reservation to execute an approved interaction (ADR 0086).
 *
 * Carries a monotonically increasing `fencingToken`; only the current (highest)
 * token may commit, and a commit is recorded at most once per interaction, so
 * a delayed or split-brain executor cannot fire the side effect twice.
 */
export interface ExecutionReservation {
  id: string;
  interactionId: string;
  requestDigest: string;
  fencingToken: number;
  holderRef: string;
  status: ExecutionReservationStatus;
  leaseExpiresAt: Date;
  committedAt?: Date;
  releasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** What `acquire` needs; the store derives id, token, status and timestamps. */
export interface AcquireReservationInput {
  id: string;
  interactionId: string;
  requestDigest: string;
  holderRef: string;
  leaseExpiresAt: Date;
}

/**
 * The reservation/fencing store (ADR 0086).
 *
 * Fencing is enforced here because it cannot be enforced anywhere else: the
 * resource that runs the side effect trusts the token the store issues, and
 * the store refuses to record a commit from a token that is not current or
 * when the interaction is already committed.
 */
export interface ExecutionReservationRepository {
  /**
   * Take a reservation, assigning the next fencing token for the interaction.
   *
   * Refuses (`ConflictError`) when the interaction already has a committed
   * reservation — the operation has fired and a fresh executor must not run it
   * again. Two acquirers computing the same next token collide on the
   * `(interaction, token)` unique index; the loser retries.
   */
  acquire(
    input: AcquireReservationInput,
    uow?: UnitOfWork,
  ): Promise<ExecutionReservation>;
  getById(id: string): Promise<ExecutionReservation | null>;
  /** The current (highest-token) held reservation for an interaction, if any. */
  getCurrent(interactionId: string): Promise<ExecutionReservation | null>;
  /**
   * Commit a reservation, exactly once, atomically.
   *
   * Succeeds only when this reservation carries the current highest token for
   * its interaction, is still `held`, its lease has not lapsed, and no
   * committed reservation exists. Otherwise it throws `ConflictError` — the
   * holder was fenced — or `NotFoundError`.
   */
  commit(
    id: string,
    expectedFencingToken: number,
    at: Date,
    uow?: UnitOfWork,
  ): Promise<ExecutionReservation>;
  /** Release a held reservation the caller is abandoning. */
  release(
    id: string,
    at: Date,
    uow?: UnitOfWork,
  ): Promise<ExecutionReservation>;
  /** Sweep held reservations past their lease to `expired`. */
  expireDue(now: Date): Promise<number>;
}
