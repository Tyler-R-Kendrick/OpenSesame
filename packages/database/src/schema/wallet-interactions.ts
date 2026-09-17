/**
 * Durable interaction-proof, wallet-registration, execution-reservation, and
 * approval-quarantine tables (ADR 0086).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, interactions, principals, timestamps } from "./index.js";

/**
 * Every attempt to answer an interaction with a cryptographic proof (ADR 0086;
 * findings F04, F05).
 *
 * The proof-of-approval check — a WebAuthn assertion, an OpenID4VP
 * presentation — used to be verified against process-local state: an in-memory
 * attempt counter and an in-memory "have I seen this assertion?" set. Both are
 * wrong the moment there is more than one process or the process restarts. An
 * attacker spreads guesses across replicas to defeat a per-process budget, and
 * a replay that a restarted process has forgotten verifies a second time. This
 * table is the durable record those defences must read and write instead.
 *
 * It never stores the proof *inputs* — the assertion bytes, the presentation,
 * any JOSE. Those are verified once at the protocol edge and dropped, exactly
 * as `ApprovalProof` documents. What is kept is the *fact* of an attempt: which
 * interaction, what mechanism, what it bound to, what came of it, and a digest
 * of the input that is enough to recognise the same proof arriving twice and
 * nothing else.
 */
export const interactionProofAttempts = pgTable(
  "interaction_proof_attempts",
  {
    /** `ipa_<base64url>`. */
    id: text("id").primaryKey(),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    /** Closed `ApprovalMechanism`: webauthn | openid4vp | session_reauth | out_of_band. */
    mechanism: text("mechanism").notNull(),
    /**
     * What became of the attempt. `accepted` is the one finalizing outcome;
     * every rejection names why so the audit trail distinguishes a wrong key
     * from a wrong digest from a stale window.
     */
    outcome: text("outcome").notNull(),
    /**
     * Digest of the proof input (assertion/presentation), for replay
     * detection. Never the input itself. Unique across the table: a proof that
     * verified once may not verify again, on any interaction, in any process.
     */
    proofInputDigest: bytea("proof_input_digest").notNull(),
    /** The digest the proof claimed to bind to. Present on every attempt. */
    boundDigest: text("bound_digest"),
    /** The interaction's `requestDigest` at attempt time, for a mismatch record. */
    expectedDigest: text("expected_digest"),
    /** Non-secret handle for the key/credential that signed. Never the key. */
    credentialRef: text("credential_ref"),
    /** Assurance the proof cleared, when it was accepted. */
    assurance: text("assurance"),
    /**
     * Who attempted, when known. `set null`, not `cascade`: the attempt is an
     * audit record and must outlive the principal, as interactions do.
     */
    approverPrincipalId: text("approver_principal_id").references(
      () => principals.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "interaction_proof_attempts_mechanism_check",
      sql`${t.mechanism} in ('webauthn','openid4vp','session_reauth','out_of_band')`,
    ),
    check(
      "interaction_proof_attempts_outcome_check",
      sql`${t.outcome} in ('accepted','rejected_digest_mismatch','rejected_verification','rejected_assurance','rejected_expired','rejected_replayed')`,
    ),
    /**
     * A proof input is answerable exactly once, anywhere. The insert is the
     * replay claim: two processes racing the same assertion both try to write
     * this digest, and the loser's insert fails rather than verifying a second
     * approval. This is the durable replacement for the in-memory seen-set.
     */
    uniqueIndex("interaction_proof_attempts_input_digest_uidx").on(
      t.proofInputDigest,
    ),
    /**
     * At most one *accepted* attempt per interaction. Inserting the accepted
     * row is the atomic finalization: the second executor to arrive with a
     * good proof collides here and is told the interaction is already answered,
     * rather than both believing they finalized it.
     */
    uniqueIndex("interaction_proof_attempts_accepted_uidx")
      .on(t.interactionId)
      .where(sql`outcome = 'accepted'`),
    /** The durable attempt-budget read: count recent attempts for one interaction. */
    index("interaction_proof_attempts_interaction_created_idx").on(
      t.interactionId,
      t.createdAt,
    ),
  ],
);

/**
 * A wallet pass registered against an interaction subject (ADR 0086).
 *
 * A Google Wallet pass — or any future `WalletPassProvider` — is a surface
 * that renders an interaction reference on a second screen. Issuing one is a
 * durable act with a lifecycle of its own: it is created `active`, and it is
 * later `revoked` (the user deleted it, or the interaction it fronted
 * settled), `expired`, or `superseded` (a re-issue over the same ceremony).
 * Nothing here is on the authorization path — a pass carries a reference and
 * authorizes nothing — but the binding must be durable so a revoke actually
 * revokes and a re-issue does not silently fork into two live passes.
 *
 * The pass never carries a credential, and neither does this row: only a
 * non-secret provider object handle and a *digest* of the reference the pass
 * embeds, never the reference itself.
 */
export const walletRegistrations = pgTable(
  "wallet_registrations",
  {
    /** `wreg_<base64url>`. */
    id: text("id").primaryKey(),
    /** e.g. `google_wallet`. The vendor stays at this boundary and no further. */
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    /** The interaction subject the pass fronts, flattened as in `interactions`. */
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    /** The provider's pass-object handle. Non-secret; never a token. */
    providerObjectRef: text("provider_object_ref").notNull(),
    /** The wallet account subject, when the provider discloses one. */
    providerSubject: text("provider_subject"),
    /** The interaction this pass was issued for, when it fronts a specific one. */
    interactionId: text("interaction_id").references(() => interactions.id, {
      onDelete: "set null",
    }),
    /** Whose authority the pass is a surface for. `set null` on erasure. */
    approverPrincipalId: text("approver_principal_id").references(
      () => principals.id,
      { onDelete: "set null" },
    ),
    /** Digest of the reference the pass embeds. Never the reference. */
    passReferenceDigest: bytea("pass_reference_digest"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    check(
      "wallet_registrations_status_check",
      sql`${t.status} in ('active','revoked','expired','superseded')`,
    ),
    /**
     * One active pass per provider per ceremony subject. Partial, so the
     * terminal rows are the history and only the live slot is exclusive —
     * mirrors `interactions_live_subject_idx`. Without it a re-issue forks a
     * second live pass over one ceremony, and revoking one leaves the other.
     */
    uniqueIndex("wallet_registrations_active_subject_uidx")
      .on(t.provider, t.subjectKind, t.subjectId)
      .where(sql`status = 'active'`),
    /** One active registration per provider pass-object; a re-bind supersedes. */
    uniqueIndex("wallet_registrations_active_object_uidx")
      .on(t.provider, t.providerObjectRef)
      .where(sql`status = 'active'`),
    index("wallet_registrations_approver_idx").on(
      t.approverPrincipalId,
      t.status,
    ),
    index("wallet_registrations_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'active'`),
  ],
);

/**
 * A fenced reservation to execute an approved interaction (ADR 0086).
 *
 * Between approving an interaction and executing the operation it authorizes
 * there is a gap, and the gap is where a second executor — a retried worker, a
 * split-brain replica — can run the same approved operation twice. The
 * interaction's own version CAS stops two callers *consuming* the row, but the
 * side effect (a payment initiated, a device authorized) can fire before the
 * consume lands. A reservation closes that: an executor takes one before it
 * acts, carrying a monotonically increasing fencing token, and the store
 * refuses to record a commit from any holder that is not the current token.
 * This is the fencing-token pattern (Kleppmann): a delayed holder that wakes
 * with a stale token is refused by the store rather than trusted by the
 * resource.
 */
export const executionReservations = pgTable(
  "execution_reservations",
  {
    /** `xrsv_<base64url>`. */
    id: text("id").primaryKey(),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => interactions.id, { onDelete: "cascade" }),
    /**
     * The digest the executor must run against. Copied from the interaction at
     * acquire time so a reservation cannot be pointed at a different operation
     * than the one that was approved.
     */
    requestDigest: text("request_digest").notNull(),
    /**
     * Monotonic per interaction. The highest token is the only holder allowed
     * to commit; a lower one is fenced. Uniqueness on `(interaction, token)`
     * serializes two acquirers that computed the same next value.
     */
    fencingToken: integer("fencing_token").notNull(),
    /** Opaque executor/worker identity. Never a credential. */
    holderRef: text("holder_ref").notNull(),
    status: text("status").notNull(),
    /** The reservation lease deadline; a held reservation past it is reclaimable. */
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    committedAt: timestamp("committed_at", {
      withTimezone: true,
      mode: "date",
    }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    check(
      "execution_reservations_status_check",
      sql`${t.status} in ('held','committed','released','expired')`,
    ),
    /** Two acquirers cannot mint the same fencing token for one interaction. */
    uniqueIndex("execution_reservations_token_uidx").on(
      t.interactionId,
      t.fencingToken,
    ),
    /**
     * At most one committed reservation per interaction — execute-once. A
     * second commit, however it raced, collides here and is refused, so the
     * operation cannot fire twice even if two holders both believed they won.
     */
    uniqueIndex("execution_reservations_committed_uidx")
      .on(t.interactionId)
      .where(sql`status = 'committed'`),
    index("execution_reservations_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`status = 'held'`),
  ],
);

/**
 * The ledger of interactions quarantined as legacy session-only approvals
 * (ADR 0086; finding F12).
 *
 * Migration 0023 revokes every interaction that is `approved` with no durable
 * `approval_proof` — the shape a pre-durable-store deployment could leave
 * behind — and records each one here first. The row is why an approval that a
 * user may remember making no longer settles: the proof was only ever held in
 * a process that is gone, so re-approval through the durable path is required.
 * Revoking rather than deleting keeps the audit trail; this table keeps the
 * reason beside it.
 */
export const interactionApprovalQuarantine = pgTable(
  "interaction_approval_quarantine",
  {
    /** The quarantined interaction's own id. One quarantine record per interaction. */
    interactionId: text("interaction_id").primaryKey(),
    /** The status the row held when it was quarantined (always `approved`). */
    priorStatus: text("prior_status").notNull(),
    reason: text("reason").notNull(),
    quarantinedAt: timestamp("quarantined_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
);
