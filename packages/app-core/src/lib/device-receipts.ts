/**
 * Receipts of what this device decided (ADR 0162).
 *
 * With no Identity API the device is the Identity plane (ADR 0160), so the
 * trail Access › Receipts reads is the vault's own: one line per decision this
 * device made for a person — a request raised, approved, denied or withdrawn;
 * an application signed in, refused or ended; a session ended; a Self-Issued
 * sign-in approved or refused; a drop opened; a live session granted; a local
 * share granted or revoked. The trail is its own sealed file
 * (`device-receipts-store.ts`), newest first, written ahead and never edited,
 * sealed under the vault (ADR 0149), and value-blind: a receipt names ids and a
 * closed enum, never a scope list, a reason, a callback address or a credential.
 * It is capped, so the oldest fall away.
 *
 * A receipt is written *after* the decision it records has committed — one
 * written before would be false if the tab died in between — and a failure to
 * write it never undoes or blocks that decision: a person who approved
 * something must not be told they did not because a ledger was full. A receipt
 * that could not be written is held, in memory and in a small sealed pending
 * list, and written ahead of the next one, when the trail is next read, and at
 * the next unlock; `pendingReceipts` says how many still wait so the panel can
 * say so. What no outbox can close is a tab that dies between the decision's
 * own commit and the first attempt, and the guarantee is worded to match: a
 * receipt is never false, and one that is late is never silent once it is known.
 */

import type { AuditOutcome, JsonObject } from "@opensesame/os-domain";
import {
  MAX_BYTES,
  MAX_RECEIPTS,
  PENDING_PATH,
  RESET_EVENT_TYPE,
  type StoredReceipt,
  TRAIL_PATH,
  UnreadableReceipts,
  buildReceipt,
  newestFirst,
  readStore,
  resetMarker,
  uniqueById,
  writeStore,
} from "./device-receipts-store.js";
import { withLocalAccessLedgerLock } from "./local-access-ledger-lock.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { tombUnlocked } from "./vfs.js";

/** Every decision a receipt can record. A closed set, one per event name. */
export const RECEIPT_KINDS = {
  "request.created": ["access.request.created", "succeeded"],
  "request.approved": ["access.request.approved", "succeeded"],
  "request.denied": ["access.request.denied", "denied"],
  "request.withdrawn": ["access.request.withdrawn", "succeeded"],
  "sign_in.granted": ["access.sign_in.granted", "succeeded"],
  "sign_in.denied": ["access.sign_in.denied", "denied"],
  "sign_in.revoked": ["access.sign_in.revoked", "succeeded"],
  "session.ended": ["access.session.revoked", "succeeded"],
  "siop.approved": ["access.siop.approved", "succeeded"],
  "siop.denied": ["access.siop.denied", "denied"],
  "drop.opened": ["access.drop.opened", "succeeded"],
  "drop.expired": ["access.drop.expired", "succeeded"],
  "drop.revoked": ["access.drop.revoked", "succeeded"],
  "live.granted": ["access.live.granted", "succeeded"],
  "share.granted": ["access.share.granted", "succeeded"],
  "share.revoked": ["access.share.revoked", "succeeded"],
} as const satisfies Record<string, readonly [string, AuditOutcome]>;

export type ReceiptKind = keyof typeof RECEIPT_KINDS;

/** Every event name a receipt carries, and the one that says a trail was replaced. */
export const RECEIPT_EVENT_TYPES: readonly string[] = [
  ...Object.values(RECEIPT_KINDS).map(([name]) => name),
  RESET_EVENT_TYPE,
];

/**
 * What a receipt is about: an application, which the trail names by its name
 * without a second lookup, or the person whose session ended.
 */
type ReceiptSubject =
  | {
      applicationId: string;
      sessionOf?: never;
      claimId?: never;
      shareId?: never;
      liveSessionId?: never;
    }
  | {
      sessionOf: string;
      applicationId?: never;
      claimId?: never;
      shareId?: never;
      liveSessionId?: never;
    }
  | {
      claimId: string;
      applicationId?: never;
      sessionOf?: never;
      shareId?: never;
      liveSessionId?: never;
    }
  | {
      shareId: string;
      applicationId?: never;
      sessionOf?: never;
      claimId?: never;
      liveSessionId?: never;
    }
  | {
      liveSessionId: string;
      applicationId?: never;
      sessionOf?: never;
      claimId?: never;
      shareId?: never;
    };

/** What a receipt names: ids only. */
export type ReceiptRef = ReceiptSubject &
  Readonly<{
    /** The access request the decision settled, when there was one. */
    requestId?: string;
    /** The local principal the decision was for. */
    subject?: string;
    /** The person who decided, when somebody other than the subject did. */
    actor?: string;
    organizationId?: string;
    /** The resource a share names. An id, never its label. */
    resourceId?: string;
  }>;

/** Receipts decided, not yet in the trail, held for this tab's vault. */
const held = new Map<string, StoredReceipt[]>();

/** The newest receipts that wait, no more than the trail itself could hold. */
const newestWaiting = (receipts: readonly StoredReceipt[]) =>
  uniqueById(receipts).slice(-MAX_RECEIPTS);

type TrailRead = { trail: StoredReceipt[]; replaced: boolean };

/**
 * The trail as it stands, or a fresh one if this build cannot read it. A trail
 * that cannot be read can never take another receipt, so the receipts after it
 * would wait for ever; it is replaced by a trail that begins with a marker
 * saying so, and the unreadable bytes, which nothing could read, are gone.
 */
async function trailOrFresh(tomb: string): Promise<TrailRead> {
  try {
    return { trail: await readStore(tomb, TRAIL_PATH), replaced: false };
  } catch (error) {
    if (error instanceof UnreadableReceipts)
      return { trail: [resetMarker()], replaced: true };
    throw error;
  }
}

function metadataOf(ref: ReceiptRef): JsonObject {
  const metadata: JsonObject = {};
  if (ref.requestId) metadata.authReqId = ref.requestId;
  if (ref.subject) metadata.subject = ref.subject;
  if (ref.actor) metadata.actor = ref.actor;
  if (ref.organizationId) metadata.organizationId = ref.organizationId;
  if (ref.claimId) metadata.claimId = ref.claimId;
  if (ref.resourceId) metadata.resourceId = ref.resourceId;
  return metadata;
}

/**
 * Write what is held, and `fresh`, ahead of the trail; what cannot be stays
 * held. Tells the other readers of the trail only when it wrote something: a
 * read that finds nothing waiting is not a change, and every reader that hears
 * of a change reads again, so announcing one here would set two tabs reading
 * each other's silence forever.
 */
async function settle(
  tomb: string,
  fresh: readonly StoredReceipt[],
): Promise<void> {
  const wrote = await withLocalAccessLedgerLock(
    tomb,
    "receipts",
    TRAIL_PATH,
    MAX_BYTES * 2,
    async () => {
      // A damaged retry list is not worth refusing every receipt over.
      const sealed = await readStore(tomb, PENDING_PATH).catch(() => []);
      const waiting = uniqueById([
        ...fresh,
        ...(held.get(tomb) ?? []),
        ...sealed,
      ]);
      const { trail, replaced } = await trailOrFresh(tomb);
      if (waiting.length === 0 && !replaced) return false;
      await writeStore(tomb, TRAIL_PATH, newestFirst(waiting, trail));
      held.delete(tomb);
      if (sealed.length > 0)
        await writeStore(tomb, PENDING_PATH, []).catch(() => undefined);
      return true;
    },
  );
  if (wrote) notifyLocalIamChange();
}

/** Keep a receipt that could not be written, to be written later. */
async function keep(tomb: string, receipt: StoredReceipt): Promise<void> {
  // A locked vault cannot be written to, and plaintext ids do not wait in
  // memory for a vault that is shut.
  if (!tombUnlocked(tomb)) return;
  const waiting = newestWaiting([...(held.get(tomb) ?? []), receipt]);
  held.set(tomb, waiting);
  try {
    await withLocalAccessLedgerLock(
      tomb,
      "receipts",
      PENDING_PATH,
      MAX_BYTES * 2,
      async () => {
        const sealed = await readStore(tomb, PENDING_PATH).catch(() => []);
        await writeStore(
          tomb,
          PENDING_PATH,
          newestWaiting([...sealed, ...waiting]),
        );
      },
    );
  } catch {
    // Held in memory for this tab at least; the panel will say it waits.
  }
}

type ReceiptTarget = Readonly<{
  targetType: "claim" | "share" | "live_session" | "principal" | "application";
  targetId: string;
}>;

function targetOf(ref: ReceiptRef): ReceiptTarget {
  if (ref.claimId !== undefined)
    return { targetType: "claim", targetId: ref.claimId };
  if (ref.shareId !== undefined)
    return { targetType: "share", targetId: ref.shareId };
  if (ref.liveSessionId !== undefined)
    return { targetType: "live_session", targetId: ref.liveSessionId };
  if (ref.sessionOf !== undefined)
    return { targetType: "principal", targetId: ref.sessionOf };
  return {
    targetType: "application",
    targetId: ref.applicationId,
  };
}

function receiptFor(kind: ReceiptKind, ref: ReceiptRef): StoredReceipt {
  const [eventType, outcome] = RECEIPT_KINDS[kind];
  return buildReceipt(
    { eventType, outcome, ...targetOf(ref) },
    metadataOf(ref),
  );
}

/**
 * Record one receipt. Never throws and never waits on the caller's lock: the
 * decision it records is already settled.
 */
export async function recordReceipt(
  tomb: string,
  kind: ReceiptKind,
  ref: ReceiptRef,
): Promise<void> {
  const receipt = receiptFor(kind, ref);
  try {
    await settle(tomb, [receipt]);
  } catch {
    await keep(tomb, receipt);
  }
}

/** How many receipts have been decided and are not yet in the trail. */
export async function pendingReceipts(tomb: string): Promise<number> {
  if (!tombUnlocked(tomb)) return 0;
  const sealed = await readStore(tomb, PENDING_PATH).catch(() => []);
  const waiting = uniqueById([...(held.get(tomb) ?? []), ...sealed]);
  // One written to the trail and not yet cleared from the list is not waiting.
  const written = new Set(
    (await readStore(tomb, TRAIL_PATH).catch(() => [])).map((row) => row.id),
  );
  return waiting.filter((row) => !written.has(row.id)).length;
}

/**
 * Write whatever is held. Returns how many still wait: zero when the trail took
 * them, or when there was nothing to write.
 */
export async function flushReceipts(tomb: string): Promise<number> {
  try {
    await settle(tomb, []);
  } catch {
    if (!tombUnlocked(tomb)) held.delete(tomb);
  }
  return pendingReceipts(tomb);
}

/** Forget what a test left held. */
export function resetHeldReceiptsForTest(): void {
  held.clear();
}

/** A receipt as the Identity plane's audit route answers it. */
export type ReceiptEvent = Readonly<{
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  metadata: JsonObject;
}>;

function asReceipt(event: StoredReceipt): ReceiptEvent {
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

/**
 * The newest receipts first, at most `limit`, after writing any that waited.
 * Throws if the vault is locked.
 */
export async function listReceipts(
  tomb: string,
  limit: number,
): Promise<ReceiptEvent[]> {
  await flushReceipts(tomb);
  const trail = await readStore(tomb, TRAIL_PATH);
  return trail.slice(0, Math.max(0, limit)).map(asReceipt);
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

/** What a receipt for an ended session names: the person it was for. */
export function sessionRef(
  session: Readonly<{ principalId: string }>,
): ReceiptRef {
  return { sessionOf: session.principalId, subject: session.principalId };
}
