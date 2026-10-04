/**
 * Receipts of what this device decided (ADR 0162).
 *
 * With no Identity API the device is the Identity plane (ADR 0160), so the
 * trail Access › Receipts reads is the vault's own. It is not a second ledger:
 * each receipt is an event appended to the sealed Access audit
 * (`local-access-audit.ts`, ADR 0015), one line per decision this device made
 * for a person — a request raised, approved, denied or withdrawn; an
 * application signed in, refused or ended; a Self-Issued sign-in approved or
 * refused. Append-only (a newer event is written ahead, none is edited), sealed
 * under the vault (ADR 0149), and value-blind: an event names ids and a closed
 * enum, never a scope list, a reason, a callback address or a credential.
 *
 * A receipt is written *after* the decision it records has committed, and a
 * failure to write it never undoes or blocks that decision: a person who
 * approved something must not be told they did not because a ledger was full.
 * The failure is the one thing this module swallows, and it says so.
 */

import type { AuditOutcome, JsonObject } from "@opensesame/os-domain";
import {
  type AccessAuditEventType,
  type LocalAccessAuditEvent,
  listAccessAuditEvents,
  recordAccessAuditEvent,
} from "./local-access-audit.js";

/** Every decision a receipt can record. A closed set, one per event name. */
export const RECEIPT_KINDS = {
  "request.created": ["access.request.created", "succeeded"],
  "request.approved": ["access.request.approved", "succeeded"],
  "request.denied": ["access.request.denied", "denied"],
  "request.withdrawn": ["access.request.withdrawn", "succeeded"],
  "sign_in.granted": ["access.sign_in.granted", "succeeded"],
  "sign_in.denied": ["access.sign_in.denied", "denied"],
  "sign_in.revoked": ["access.sign_in.revoked", "succeeded"],
  "siop.approved": ["access.siop.approved", "succeeded"],
  "siop.denied": ["access.siop.denied", "denied"],
} as const satisfies Record<
  string,
  readonly [AccessAuditEventType, AuditOutcome]
>;

export type ReceiptKind = keyof typeof RECEIPT_KINDS;

/**
 * What a receipt names: ids only. Every decision is about an application, so
 * the trail can say which one by its name without a second lookup.
 */
export type ReceiptRef = Readonly<{
  applicationId: string;
  /** The access request the decision settled, when there was one. */
  requestId?: string;
  /** The local principal the decision was for. */
  subject?: string;
  /** The person who decided, when somebody other than the subject did. */
  actor?: string;
  organizationId?: string;
}>;

/**
 * Append one receipt. Never throws and never waits on the caller's lock: the
 * decision it records is already settled.
 */
export async function recordReceipt(
  tomb: string,
  kind: ReceiptKind,
  ref: ReceiptRef,
): Promise<void> {
  const [eventType, outcome] = RECEIPT_KINDS[kind];
  const metadata: JsonObject = {};
  if (ref.requestId) metadata.authReqId = ref.requestId;
  if (ref.subject) metadata.subject = ref.subject;
  if (ref.actor) metadata.actor = ref.actor;
  if (ref.organizationId) metadata.organizationId = ref.organizationId;
  try {
    await recordAccessAuditEvent(tomb, {
      eventType,
      outcome,
      targetType: "application",
      targetId: ref.applicationId,
      metadata,
      activity: false,
    });
  } catch {
    // The decision stands; a receipt that could not be written is not shown.
  }
}

/** A receipt as the Identity plane's audit route answers it. */
export type ReceiptEvent = Readonly<{
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  metadata: JsonObject;
}>;

function asReceipt(event: LocalAccessAuditEvent): ReceiptEvent {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    outcome: event.outcome,
    metadata: {
      ...event.metadata,
      targetType: event.targetType,
      targetId: event.targetId,
    },
  };
}

/** The newest receipts first, at most `limit`. Throws if the vault is locked. */
export async function listReceipts(
  tomb: string,
  limit: number,
): Promise<ReceiptEvent[]> {
  const events = await listAccessAuditEvents(tomb);
  return events.slice(0, Math.max(0, limit)).map(asReceipt);
}

/** What a receipt for a local access request names: ids, from its summary. */
export function requestRef(
  request: Readonly<{
    id: string;
    applicationId: string;
    requesterId: string;
    organizationId: string;
  }>,
): ReceiptRef {
  return {
    applicationId: request.applicationId,
    requestId: request.id,
    subject: request.requesterId,
    organizationId: request.organizationId,
  };
}

/** What a receipt for an application's grant names: the app and the person. */
export function grantRef(
  grant: Readonly<{
    applicationId: string;
    principalId: string;
    organizationId: string;
  }>,
): ReceiptRef {
  return {
    applicationId: grant.applicationId,
    subject: grant.principalId,
    organizationId: grant.organizationId,
  };
}
