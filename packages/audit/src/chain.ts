import { createHash } from "node:crypto";
import type { AuditEvent } from "@opensesame/os-domain";
import type { AuditSink } from "./append.js";

/**
 * Tamper evidence for the control-plane audit trail.
 *
 * Until now an event could be edited or removed in place and the trail would
 * still read as a trail. Receipts on the Rust side are signed; this is the
 * cheaper half of the same idea: each event carries the digest of the one before
 * it, so an alteration anywhere breaks every link after it and a deletion leaves
 * a gap that names itself.
 *
 * A digest is not a signature. It stops a trail from being quietly rewritten by
 * something that cannot recompute the whole chain; a writer that can rewrite
 * every later row is a different threat and needs a signer.
 */

/** The digest a chain starts from, so the first event has something to point at. */
export const AUDIT_CHAIN_GENESIS = "genesis";

/**
 * The bytes an event's digest covers: every field that carries meaning, in a
 * fixed order, so two processes agree on the same event's digest.
 */
export function canonicalAuditPayload(
  event: AuditEvent,
  previousDigest: string,
): string {
  return JSON.stringify([
    previousDigest,
    event.id,
    event.occurredAt.toISOString(),
    event.eventType,
    event.outcome,
    event.correlationId,
    event.causationId ?? null,
    event.principalId ?? null,
    event.actorType ?? null,
    event.actorId ?? null,
    event.agentInstanceId ?? null,
    event.clientId ?? null,
    event.organizationId ?? null,
    event.projectId ?? null,
    event.claimId ?? null,
    event.sessionId ?? null,
    event.targetType ?? null,
    event.targetId ?? null,
    stableJson(event.metadata),
  ]);
}

/** Object key order is not evidence, so it is not allowed to change the digest. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(row[k])}`).join(",")}}`;
}

export function auditEventDigest(
  event: AuditEvent,
  previousDigest: string,
): string {
  return createHash("sha256")
    .update(canonicalAuditPayload(event, previousDigest))
    .digest("hex");
}

export interface ChainedAuditSinkOptions {
  /** Digest of the newest event already in the store, when resuming a trail. */
  tip?: string;
}

/**
 * Wrap a sink so every event it appends is linked to the previous one.
 *
 * Appends are serialized: two events sharing a predecessor would each claim to
 * follow it and one of them would be unverifiable, so a second append waits for
 * the first to land. Only the tip is held, never the trail.
 */
export function createChainedAuditSink(
  inner: AuditSink,
  options: ChainedAuditSinkOptions = {},
): AuditSink & { tip(): string } {
  let tip = options.tip ?? AUDIT_CHAIN_GENESIS;
  let queue: Promise<unknown> = Promise.resolve();

  async function link(event: AuditEvent): Promise<AuditEvent> {
    const previousDigest = tip;
    const linked: AuditEvent = {
      ...event,
      previousDigest,
      digest: auditEventDigest(event, previousDigest),
    };
    const stored = await inner.append(linked);
    // Only advance once the event is durable; a failed append must not leave a
    // gap that later events would be measured against.
    tip = linked.digest ?? previousDigest;
    return stored;
  }

  return {
    append(event: AuditEvent): Promise<AuditEvent> {
      const next = queue.then(
        () => link(event),
        () => link(event),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    tip: () => tip,
  };
}

export type AuditChainVerdict =
  | { ok: true; tip: string }
  | { ok: false; reason: "unlinked" | "altered" | "broken"; eventId: string };

/**
 * Verify a run of events, oldest first.
 *
 * `unlinked` means an event carries no digest at all, `altered` means its own
 * contents no longer produce its digest, and `broken` means it does not follow
 * the event handed to us before it — the shape a deletion or reordering takes.
 */
export function verifyAuditChain(
  events: AuditEvent[],
  from: string = AUDIT_CHAIN_GENESIS,
): AuditChainVerdict {
  let expected = from;
  for (const event of events) {
    if (event.digest === undefined || event.previousDigest === undefined) {
      return { ok: false, reason: "unlinked", eventId: event.id };
    }
    if (event.previousDigest !== expected) {
      return { ok: false, reason: "broken", eventId: event.id };
    }
    if (auditEventDigest(event, event.previousDigest) !== event.digest) {
      return { ok: false, reason: "altered", eventId: event.id };
    }
    expected = event.digest;
  }
  return { ok: true, tip: expected };
}
