import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type { NewOutboxEvent, UnitOfWork } from "@opensesame/database";
import {
  type AuthorizationDetail,
  type Interaction,
  type InteractionKind,
  type JsonObject,
  canonicalRequestDigest,
  digestMatches,
  overlapCast,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { inboxRef } from "./interaction-handles.js";

/**
 * Subject adapters + the settlement executor (ADR 0086 §"an executor …", ADR
 * 0009).
 *
 * The interaction layer answers one question — did a human approve this? — and
 * then stops. Spending that approval used to be the whole of `/consume`:
 * flip the row to `consumed`, write an audit line, return. But a consumed row
 * is a fact about the *envelope*, not an effect on the ceremony the envelope
 * fronts. A device-authorization interaction that reads `consumed` while the
 * device session it named is still `pending` has approved nothing; the
 * approval evaporated at the boundary between the two records.
 *
 * This module closes that gap. Every interaction kind maps to a subject
 * adapter, and consuming an approval now runs the adapter: it re-derives the
 * binding the approval was given under, refuses if that binding does not hold,
 * and only then emits the durable, digest-bound command that settles the real
 * ceremony. The command rides the same transactional outbox the rest of the
 * service uses, in the same database transaction as the `consumed` flip, so a
 * consumption and its effect are one atomic write — there is no state in which
 * the envelope is spent and the ceremony was never told.
 *
 * Two invariants carry the weight:
 *
 * 1. **The executor recomputes the digest before it dispatches.** It never
 *    trusts the interaction machine's own approve-time check: an executor is a
 *    separate trust domain (the relay case of ADR 0046 puts it on the holder's
 *    own daemon), so it verifies, from the interaction's stored fields alone,
 *    that the approval it is about to spend was bound to exactly this subject.
 *    A digest that does not recompute, or a proof bound to a different request,
 *    is a refusal — the approval is not spent and no command is emitted.
 * 2. **Kinds are not interchangeable.** The adapter registry is keyed by the
 *    subject's own kind, and a kind with no adapter is a fail-closed refusal,
 *    never a silent no-op. A payment approval cannot settle a claim because
 *    the two kinds resolve to two different adapters and two different digests.
 */

/**
 * Kinds whose approval authorizes an *operation* and so must carry a request
 * digest (ADR 0086; mirrors the interaction machine's `KINDS_REQUIRING_DIGEST`).
 *
 * Held here as the executor's own copy on purpose. Defense in depth means the
 * thing that spends an approval does not take the minting service's word for
 * which kinds needed a digest; if the two ever disagree, the safe direction is
 * for the executor to demand one.
 */
const DIGEST_REQUIRED_KINDS: ReadonlySet<InteractionKind> = new Set([
  "authorization_request",
  "transaction_authorization",
  "grant_claim",
]);

/** Why the executor would not spend an approval. Fail-closed, every one. */
export type BindingRefusal =
  | "unsupported_subject"
  | "subject_unbound"
  | "missing_digest"
  | "missing_proof"
  | "proof_unbound"
  | "digest_recompute_mismatch";

export type BindingCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BindingRefusal };

/**
 * The durable command that settles a real ceremony.
 *
 * It is an outbox event, not an HTTP call: the subject may live in another
 * plane (a device session and a browser pairing are Host-plane records), and
 * the executor's job is to emit a bound, at-least-once command that the plane
 * owning the subject drains — not to reach across the boundary synchronously
 * and couple the two services' availability. The payload is deliberately
 * internal (it carries the subject id, which never travels to a client) and
 * carries the digest the effect is bound to, so the draining side can refuse
 * an effect whose digest it cannot reproduce.
 */
export interface SubjectSettlement {
  readonly command: NewOutboxEvent;
}

/**
 * One adapter per interaction kind.
 *
 * `requiresDigest` decides how the binding is checked; `command` builds the
 * settlement the drainer runs. Nothing here performs the effect inline — that
 * belongs to the plane that owns the subject — so an adapter is total, pure,
 * and cannot fail for a reason other than the binding the executor already
 * checked.
 */
export interface SubjectAdapter {
  readonly kind: InteractionKind;
  readonly requiresDigest: boolean;
  command(interaction: Interaction): SubjectSettlement;
}

/** The outbox event a kind's settlement rides, bound to the request digest. */
function settlementCommand(
  interaction: Interaction,
  eventType: string,
): SubjectSettlement {
  // Internal command payload: the subject id is here because the drainer must
  // settle exactly this record, and this event never reaches a client. Only
  // fields the effect needs — no binding message, no authorization details,
  // both of which quote requester-authored text.
  const payload: JsonObject = {
    interactionId: interaction.id,
    subjectKind: interaction.subject.kind,
    subjectId: interaction.subject.subjectId,
    ...(interaction.requestDigest
      ? { requestDigest: interaction.requestDigest }
      : undefined),
    ...(interaction.approverPrincipalId
      ? { approverPrincipalId: interaction.approverPrincipalId }
      : undefined),
    ...(interaction.resourceRef
      ? { resourceRef: interaction.resourceRef }
      : undefined),
  };
  return {
    command: {
      // A fresh id per emission: at-least-once delivery is fine because the
      // drainer keys idempotency on `interactionId`, which is single-consume.
      id: randomBytes(16).toString("hex"),
      aggregateType: "interaction_subject",
      aggregateId: interaction.id,
      eventType,
      payload,
    },
  };
}

function adapter(
  kind: InteractionKind,
  requiresDigest: boolean,
  eventType: string,
): SubjectAdapter {
  return {
    kind,
    requiresDigest,
    command: (interaction) => settlementCommand(interaction, eventType),
  };
}

/**
 * The registry. Exhaustive over `InteractionKind` by construction — a new kind
 * added to the union without an adapter here is a type error, not a runtime
 * surprise, which is what keeps "unsupported kind" from quietly meaning "does
 * nothing".
 *
 * The digest split is ADR 0009's: approving a device or pairing one says a
 * session may exist and claiming says a principal owns a resource — neither
 * carries an amount or a target that could be swapped afterwards, so neither
 * needs a digest. Allowing a call, delegating a grant, and moving money each
 * carry one, and for those the digest is the whole binding.
 */
export const SUBJECT_ADAPTERS = {
  device_authorization: adapter(
    "device_authorization",
    false,
    "device_authorization.settle",
  ),
  pairing: adapter("pairing", false, "pairing.settle"),
  claim: adapter("claim", false, "claim.settle"),
  grant_claim: adapter("grant_claim", true, "grant_claim.settle"),
  authorization_request: adapter(
    "authorization_request",
    true,
    "authorization_request.settle",
  ),
  transaction_authorization: adapter(
    "transaction_authorization",
    true,
    "transaction_authorization.settle",
  ),
} as const satisfies Record<InteractionKind, SubjectAdapter>;

/** The adapter for a kind, or null when none is registered (fail-closed). */
export function subjectAdapterFor(
  kind: InteractionKind,
): SubjectAdapter | null {
  return SUBJECT_ADAPTERS[kind] ?? null;
}

/**
 * Recompute the request digest from the interaction's own stored fields.
 *
 * The approver handle is regenerated from the stored principal id: creation
 * hashed the requester-supplied `approverRef`, and `resolveInboxRef` verified
 * that handle's MAC before storing the principal it addressed, so
 * `inboxRef(approverPrincipalId)` reproduces the exact bytes that went into
 * the digest. Everything else — kind, subject, requester handle, details,
 * binding message, resource, expiry — is read straight off the row.
 */
function recomputeDigest(
  interaction: Interaction,
  pepper: string,
): string | null {
  const approverPrincipalId = interaction.approverPrincipalId;
  const requesterRefValue = interaction.requesterRef;
  if (!approverPrincipalId || !requesterRefValue) return null;
  const details: AuthorizationDetail[] = interaction.authorizationDetails.map(
    (detail) => overlapCast<JsonObject, AuthorizationDetail>(detail),
  );
  return canonicalRequestDigest({
    kind: interaction.kind,
    subject: `${interaction.subject.kind}:${interaction.subject.subjectId}`,
    approverRef: inboxRef(approverPrincipalId, pepper),
    requesterRef: requesterRefValue,
    authorizationDetails: details,
    bindingMessage: interaction.bindingMessage ?? "",
    ...(interaction.resourceRef
      ? { resourceRef: interaction.resourceRef }
      : undefined),
    expiresAt: interaction.expiresAt.toISOString(),
  });
}

/**
 * Verify the approval binds to exactly this subject, before anything is spent.
 *
 * This is the T-16 check: the executor's independent recomputation. For a
 * digest-carrying kind it demands a stored digest, a proof bound to that
 * digest, and a recomputation that reproduces it. For a session kind (device,
 * pairing, claim) there is no operation digest to bind, so the binding is the
 * subject identity the machine already carried through approval — but a stray
 * digest on such a kind, or a missing subject id, is still refused rather than
 * ignored.
 */
export function verifyInteractionBinding(
  ctx: AppContext,
  interaction: Interaction,
): BindingCheck {
  const adapterForKind = subjectAdapterFor(interaction.kind);
  if (!adapterForKind) return { ok: false, reason: "unsupported_subject" };
  if (!interaction.subject.subjectId) {
    return { ok: false, reason: "subject_unbound" };
  }

  if (interaction.requestDigest === undefined) {
    // No operation digest. Legitimate only for a session kind; a digest kind
    // that reached approval without one is a proof bound to nothing.
    return adapterForKind.requiresDigest
      ? { ok: false, reason: "missing_digest" }
      : { ok: true };
  }

  // A digest is present, so it must be a real, checkable binding regardless of
  // kind: the proof has to commit to it, and it has to be the digest the
  // interaction's own fields produce.
  const proof = interaction.approvalProof;
  if (!proof) return { ok: false, reason: "missing_proof" };
  if (!digestMatches(interaction.requestDigest, proof.boundDigest)) {
    return { ok: false, reason: "proof_unbound" };
  }
  const recomputed = recomputeDigest(interaction, ctx.config.claimPepper);
  if (recomputed === null) return { ok: false, reason: "subject_unbound" };
  if (!digestMatches(interaction.requestDigest, recomputed)) {
    return { ok: false, reason: "digest_recompute_mismatch" };
  }
  return { ok: true };
}

export type SettlementResult =
  | { readonly ok: true; readonly command: NewOutboxEvent }
  | { readonly ok: false; readonly reason: BindingRefusal };

/**
 * The executor. Verify the binding, then — and only then — build the durable
 * settlement command and append it to the outbox inside the caller's
 * transaction.
 *
 * The ordering is the contract: binding is checked before dispatch, and the
 * append shares the `uow` the caller used to flip the interaction to
 * `consumed`, so a consumption without its effect, or an effect without its
 * consumption, cannot be committed. A refusal returns without touching the
 * outbox, leaving the caller to abort the whole transaction and refuse the
 * consume.
 */
export async function settleInteractionSubject(
  ctx: AppContext,
  interaction: Interaction,
  uow: UnitOfWork,
): Promise<SettlementResult> {
  const binding = verifyInteractionBinding(ctx, interaction);
  if (!binding.ok) return { ok: false, reason: binding.reason };
  const adapterForKind = subjectAdapterFor(interaction.kind);
  // Unreachable once the binding check passed — it refuses an unknown kind —
  // but narrowing it here keeps the dispatch total without an assertion.
  if (!adapterForKind) return { ok: false, reason: "unsupported_subject" };
  const { command } = adapterForKind.command(interaction);
  await ctx.repos.outbox.append(command, uow);
  return { ok: true, command };
}

/**
 * Record a refused settlement.
 *
 * A consume that could not verify its own binding is the event worth keeping:
 * it is the shape of an approval-transfer attempt (a proof from one request
 * presented against another subject), and a trail of successful consumptions
 * cannot show it. The subject id never reaches the audit row — the whole layer
 * rests on a reference not being convertible into the id it fronts — so only
 * the kind and the reason are kept.
 */
export async function auditSettlementRefusal(
  ctx: AppContext,
  interaction: Interaction,
  reason: BindingRefusal,
  correlationId?: string,
): Promise<void> {
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "security.interaction.binding_refused",
    ...(interaction.approverPrincipalId
      ? { principalId: interaction.approverPrincipalId }
      : undefined),
    actorType: "human",
    outcome: "denied",
    ...(correlationId ? { correlationId } : undefined),
    targetType: "interaction",
    targetId: interaction.id,
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      subjectKind: interaction.subject.kind,
      reason,
    },
  });
}
