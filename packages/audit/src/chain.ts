import { createHash, timingSafeEqual } from "node:crypto";
import {
  isFunction,
  isString,
  isTypeofObject,
  overlapCast,
  type AuditEvent,
  type BoundaryValue,
  type JsonObject,
} from "@opensesame/os-domain";
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
function stableJson(value: BoundaryValue): string {
  if (value === null || !isTypeofObject(value))
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = overlapCast<BoundaryValue, Record<string, BoundaryValue>>(value);
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

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ChainedAuditSinkOptions {
  /**
   * Digest of the newest event already in the store.
   *
   * Without it a process starts a fresh chain at genesis, and a trail becomes one
   * disconnected run per process lifetime — which is also exactly what deleting a
   * contiguous tail looks like. A function is accepted because the tip has to be
   * read from the store, and it is resolved once, before the first append, inside
   * the same queue that serializes appends.
   */
  tip?: string | (() => Promise<string | undefined>);
  /** Retry once after another process wins the durable predecessor slot. */
  retryOnConflict?: (error: unknown) => boolean;
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
  let tip = isString(options.tip) ? options.tip : AUDIT_CHAIN_GENESIS;
  const resolveTip = isFunction(options.tip) ? options.tip : undefined;
  let resolved = resolveTip === undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function link(
    event: AuditEvent,
    uow?: BoundaryValue,
  ): Promise<AuditEvent> {
    if (!resolved && resolveTip) {
      // A store that cannot be read leaves the tip at genesis: refusing to write
      // the event would lose the trail entirely, which is worse than a chain with
      // a visible seam in it.
      resolved = true;
      try {
        tip = (await resolveTip()) ?? AUDIT_CHAIN_GENESIS;
      } catch {
        tip = AUDIT_CHAIN_GENESIS;
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      const previousDigest = tip;
      const linked: AuditEvent = {
        ...event,
        previousDigest,
        digest: auditEventDigest(event, previousDigest),
      };
      try {
        const stored = await inner.append(linked, uow);
        // Only advance once the event is durable; a failed append must not leave a
        // gap that later events would be measured against.
        tip = linked.digest ?? previousDigest;
        return stored;
      } catch (error) {
        if (attempt > 0 || !resolveTip || !options.retryOnConflict?.(error)) {
          throw error;
        }
        tip = (await resolveTip()) ?? AUDIT_CHAIN_GENESIS;
      }
    }
  }

  return {
    append(event: AuditEvent, uow?: BoundaryValue): Promise<AuditEvent> {
      const next = queue.then(
        () => link(event, uow),
        () => link(event, uow),
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
    if (!equalDigest(event.previousDigest, expected)) {
      return { ok: false, reason: "broken", eventId: event.id };
    }
    if (
      !equalDigest(auditEventDigest(event, event.previousDigest), event.digest)
    ) {
      return { ok: false, reason: "altered", eventId: event.id };
    }
    expected = event.digest;
  }
  return { ok: true, tip: expected };
}
