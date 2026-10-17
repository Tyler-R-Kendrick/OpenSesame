/**
 * Value-blind receipts for a drop, a live grant, or a local share (PF-24).
 * Ids only, written after the action commits. A failed write does not undo it.
 * System share writes are not callers. Locked-vault drop expiry waits.
 */

import { scrubText } from "@opensesame/log-scrub";
import type { JsonObject } from "@opensesame/os-domain";
import {
  type ActivityOutcome,
  type RecordActivityInput,
  activitySeams,
  flushActivityLog,
  recordActivityEvent,
} from "./activity-log.js";
import {
  RECEIPT_KINDS,
  type ReceiptKind,
  type ReceiptRef,
  flushReceipts,
  recordReceipt,
} from "./device-receipts.js";
import {
  planDropRefusal,
  resetRefusalTalliesForTest,
  reviseDropRefusal,
} from "./sharing-receipts-tally.js";

const seen = new Set<string>();
const SEEN_MAX = 256;
let chain: Promise<void> = Promise.resolve();
let heldDropExpiry: string | undefined;

/** Outbound send ledger tomb for a claim id; wired from `outbound-drops.ts`. */
let outboundSenderTombForClaim: (claimId: string) => string | null = () => null;
let outboundLockedOut: (claimId: string) => void = () => {};

/** Wires the sender-ledger hooks without importing the outbound ledger here. */
export function bindDropReceiptOutbound(
  resolver: (claimId: string) => string | null,
  lockedOut: (claimId: string) => void,
): void {
  outboundSenderTombForClaim = resolver;
  outboundLockedOut = lockedOut;
}

function tombsForDropReceipt(claimId: string): string[] {
  const tombs: string[] = [];
  const sender = outboundSenderTombForClaim(claimId);
  const active = activitySeams.activeTomb();
  if (sender) tombs.push(sender);
  if (active && active !== sender) tombs.push(active);
  return tombs;
}

function tombForSenderDropReceipt(claimId: string): string | null {
  return outboundSenderTombForClaim(claimId) ?? activitySeams.activeTomb();
}

export function flushHeldDropNotes(): void {
  const id = heldDropExpiry;
  if (!id) return;
  const tomb = tombForSenderDropReceipt(id);
  if (!tomb) return;
  heldDropExpiry = undefined;
  noteDropExpired(id);
}

/** An id the scrubber would leave unchanged, and nothing longer than a resource id. */
function blindId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (scrubText(trimmed) !== trimmed) return null;
  return trimmed;
}

function remember(key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.add(key);
  return true;
}

function write(
  tomb: string,
  activity: RecordActivityInput,
  kind: ReceiptKind,
  ref: ReceiptRef,
): void {
  const run = Promise.all([
    recordActivityEvent(tomb, activity).then(
      () => undefined,
      () => undefined,
    ),
    recordReceipt(tomb, kind, ref),
  ]).then(
    () => undefined,
    () => undefined,
  );
  chain = chain.then(
    () => run,
    () => run,
  );
}

export async function flushSharingReceipts(): Promise<void> {
  await chain;
  await flushActivityLog();
  const tomb = activitySeams.activeTomb();
  if (tomb) await flushReceipts(tomb).catch(() => 0);
}

export function resetSharingReceiptsForTest(): void {
  seen.clear();
  heldDropExpiry = undefined;
  resetRefusalTalliesForTest();
}

export function noteDropSent(
  tomb: string,
  claimId: string,
  link?: { sourceItemId?: string | null; vaultItemId?: string | null },
): void {
  const id = blindId(claimId);
  if (!id || !tomb || !remember(`drop-sent:${id}`)) return;
  const metadata: JsonObject = { claimId: id };
  const sourceItemId = link?.sourceItemId ? blindId(link.sourceItemId) : null;
  const vaultItemId = link?.vaultItemId ? blindId(link.vaultItemId) : null;
  if (sourceItemId) metadata.sourceItemId = sourceItemId;
  if (vaultItemId) metadata.vaultItemId = vaultItemId;
  const ref: ReceiptRef = sourceItemId
    ? { claimId: id, resourceId: sourceItemId }
    : { claimId: id };
  write(
    tomb,
    {
      category: "vault",
      type: "vault.drop.sent",
      summary: "Drop sent",
      outcome: "succeeded",
      targetType: "claim",
      targetId: id,
      metadata,
    },
    "drop.sent",
    ref,
  );
}

export function noteDropOpened(claimId: string): void {
  const id = blindId(claimId);
  if (!id) return;
  const metadata: JsonObject = { claimId: id };
  const activity = {
    category: "vault" as const,
    type: "vault.drop.opened",
    summary: "Drop opened",
    outcome: "succeeded" as const,
    targetType: "claim" as const,
    targetId: id,
    metadata,
  };
  for (const tomb of tombsForDropReceipt(id)) {
    if (!remember(`drop-opened:${tomb}:${id}`)) continue;
    write(tomb, activity, "drop.opened", { claimId: id });
  }
}

function noteSenderDropState(
  claimId: string,
  rememberKey: string,
  vaultType: string,
  summary: string,
  outcome: ActivityOutcome,
  deviceKind: ReceiptKind,
  count?: number,
): boolean {
  const id = blindId(claimId);
  if (!id) return false;
  const tomb = tombForSenderDropReceipt(id);
  if (!tomb || !remember(`${rememberKey}:${tomb}:${id}`)) return false;
  const metadata: JsonObject = { claimId: id };
  if (count !== undefined) metadata.count = count;
  write(
    tomb,
    {
      category: "vault",
      type: vaultType,
      summary,
      outcome,
      targetType: "claim",
      targetId: id,
      metadata,
    },
    deviceKind,
    count === undefined ? { claimId: id } : { claimId: id, count },
  );
  return true;
}

function enqueueReceiptWork(task: () => Promise<void>): void {
  chain = chain.then(task, task);
}

export function noteDropExpired(claimId: string): void {
  const id = blindId(claimId);
  if (!id) return;
  if (!tombForSenderDropReceipt(id)) {
    heldDropExpiry = id;
    return;
  }
  noteSenderDropState(
    claimId,
    "drop-expired",
    "vault.drop.expired",
    "Drop expired",
    "succeeded",
    "drop.expired",
  );
}

export function noteDropLockedOut(claimId: string): void {
  const wrote = noteSenderDropState(
    claimId,
    "drop-locked",
    "vault.drop.locked_out",
    "Drop locked out",
    "denied",
    "drop.locked_out",
  );
  if (wrote) outboundLockedOut(claimId);
}

export function noteDropRefused(claimId: string, wrongCodes?: number): void {
  const id = blindId(claimId);
  const tomb = id ? tombForSenderDropReceipt(id) : null;
  const noted =
    id !== null && tomb !== null && seen.has(`drop-refused:${tomb}:${id}`);
  const plan = planDropRefusal(id, tomb, wrongCodes, noted);
  if (!id || !tomb || plan.action === "skip") return;
  if (plan.action === "revise") {
    enqueueReceiptWork(() =>
      reviseDropRefusal(tomb, id, plan.count, plan.summary),
    );
    return;
  }
  noteSenderDropState(
    claimId,
    "drop-refused",
    "vault.drop.refused",
    plan.summary,
    "denied",
    "drop.refused",
    plan.count,
  );
}

export function noteDropRevoked(claimId: string): void {
  noteSenderDropState(
    claimId,
    "drop-revoked",
    "vault.drop.revoked",
    "Drop revoked",
    "succeeded",
    "drop.revoked",
  );
}

export function noteLiveSessionEnded(liveSessionId: string): void {
  const session = blindId(liveSessionId);
  const tomb = activitySeams.activeTomb();
  if (!session || !tomb || !remember(`live-ended:${session}`)) return;
  write(
    tomb,
    {
      category: "access",
      type: "access.live.ended",
      summary: "Live session ended",
      outcome: "succeeded",
      targetType: "live_session",
      targetId: session,
      metadata: {},
    },
    "live.ended",
    { liveSessionId: session },
  );
}

export function noteLiveSessionGranted(
  sessionId: string,
  guestId: string,
): void {
  const session = blindId(sessionId);
  const guest = blindId(guestId);
  const tomb = activitySeams.activeTomb();
  if (!session || !guest || !tomb || !remember(`live:${session}:${guest}`))
    return;
  write(
    tomb,
    {
      category: "access",
      type: "access.live.granted",
      summary: "Live session granted",
      outcome: "succeeded",
      targetType: "live_session",
      targetId: session,
      metadata: { subject: guest },
    },
    "live.granted",
    { liveSessionId: session, subject: guest },
  );
}

const GRANT_RECEIPT_KIND = [
  "share.approved",
  "share.denied",
] as const satisfies readonly [ReceiptKind, ReceiptKind];

export function noteShareRequested(
  tomb: string,
  share: { id: string; principalId: string; resourceId: string },
): void {
  const id = blindId(share.id);
  const subject = blindId(share.principalId);
  const resourceId = blindId(share.resourceId);
  if (!tomb || !id || !subject || !resourceId) return;
  if (!remember(`share.requested:${id}`)) return;
  const metadata: JsonObject = { subject, resourceId };
  write(
    tomb,
    {
      category: "access",
      type: "access.share.requested",
      summary: "Share requested",
      outcome: "succeeded",
      targetType: "share",
      targetId: id,
      metadata,
    },
    "share.requested",
    { shareId: id, subject, resourceId },
  );
}

export function noteShareGrantStep(
  tomb: string,
  step: 0 | 1,
  share: { id: string; principalId: string; resourceId: string },
): void {
  const id = blindId(share.id);
  const subject = blindId(share.principalId);
  const resourceId = blindId(share.resourceId);
  const kind = GRANT_RECEIPT_KIND[step];
  if (!tomb || !id || !subject || !resourceId) return;
  if (!remember(`${kind}:${id}`)) return;
  const [type, outcome] = RECEIPT_KINDS[kind];
  const metadata: JsonObject = { subject, resourceId };
  write(
    tomb,
    {
      category: "access",
      type,
      summary: `Share ${kind.slice(6)}`,
      outcome,
      targetType: "share",
      targetId: id,
      metadata,
    },
    kind,
    { shareId: id, subject, resourceId },
  );
}

export function noteLocalShare(
  tomb: string,
  action: "granted" | "revoked",
  share: { id: string; principalId: string; resourceId: string },
): void {
  const id = blindId(share.id);
  const subject = blindId(share.principalId);
  const resourceId = blindId(share.resourceId);
  if (!tomb || !id || !subject || !resourceId) return;
  if (!remember(`share:${action}:${id}`)) return;
  const granted = action === "granted";
  const metadata: JsonObject = { subject, resourceId };
  write(
    tomb,
    {
      category: "access",
      type: granted ? "access.share.granted" : "access.share.revoked",
      summary: granted ? "Share granted" : "Share revoked",
      outcome: "succeeded",
      targetType: "share",
      targetId: id,
      metadata,
    },
    granted ? "share.granted" : "share.revoked",
    { shareId: id, subject, resourceId },
  );
}
