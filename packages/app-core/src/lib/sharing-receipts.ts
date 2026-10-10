/**
 * Value-blind receipts for a drop opened, a live session granted, or a
 * person's local share granted or revoked (PF-24).
 *
 * Each one is an activity line and a device receipt, written after the
 * action commits. Both name ids only — a claim, a session, a guest, a share,
 * a principal, a resource — never a label, a code, a bearer, a link, a name
 * or a payload. A failure to write does not undo the action. While the vault
 * is locked, drop expiry notes wait for unlock.
 *
 * System share writes (a standing renewal, a vault session issuing its own
 * rows) are not callers. Those are not a person's decision.
 */

import { scrubText } from "@opensesame/log-scrub";
import type { JsonObject } from "@opensesame/os-domain";
import {
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

const seen = new Set<string>();
const SEEN_MAX = 256;
let chain: Promise<void> = Promise.resolve();
let heldDropExpiry: string | undefined;

export function flushHeldDropNotes(): void {
  const tomb = activitySeams.activeTomb();
  const id = heldDropExpiry;
  if (!tomb || !id) return;
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

/** Settle receipts already fired, including the activity line a receipt's notice adds. */
export async function flushSharingReceipts(): Promise<void> {
  await chain;
  await flushActivityLog();
  const tomb = activitySeams.activeTomb();
  if (tomb) await flushReceipts(tomb).catch(() => 0);
}

/** Test-only: forget which ids this tab already recorded. */
export function resetSharingReceiptsForTest(): void {
  seen.clear();
  heldDropExpiry = undefined;
}

/** The claim was presented. `claimId` is the id, never the bearer. */
export function noteDropOpened(claimId: string): void {
  const id = blindId(claimId);
  const tomb = activitySeams.activeTomb();
  if (!id || !tomb || !remember(`drop-opened:${id}`)) return;
  const metadata: JsonObject = { claimId: id };
  write(
    tomb,
    {
      category: "vault",
      type: "vault.drop.opened",
      summary: "Drop opened",
      outcome: "succeeded",
      targetType: "claim",
      targetId: id,
      metadata,
    },
    "drop.opened",
    { claimId: id },
  );
}

/** The sender's drop passed its TTL with no claim. */
export function noteDropExpired(claimId: string): void {
  const id = blindId(claimId);
  const tomb = activitySeams.activeTomb();
  if (!id) return;
  if (!tomb) {
    heldDropExpiry = id;
    return;
  }
  if (!remember(`drop-expired:${id}`)) return;
  const metadata: JsonObject = { claimId: id };
  write(
    tomb,
    {
      category: "vault",
      type: "vault.drop.expired",
      summary: "Drop expired",
      outcome: "succeeded",
      targetType: "claim",
      targetId: id,
      metadata,
    },
    "drop.expired",
    { claimId: id },
  );
}

/** The sender's drop was locked out after too many wrong codes. */
export function noteDropLockedOut(claimId: string): void {
  const id = blindId(claimId);
  const tomb = activitySeams.activeTomb();
  if (!id || !tomb || !remember(`drop-locked:${id}`)) return;
  const metadata: JsonObject = { claimId: id };
  write(
    tomb,
    {
      category: "vault",
      type: "vault.drop.locked_out",
      summary: "Drop locked out",
      outcome: "denied",
      targetType: "claim",
      targetId: id,
      metadata,
    },
    "drop.locked_out",
    { claimId: id },
  );
}

/** The sender revoked the drop before it was claimed. */
export function noteDropRevoked(claimId: string): void {
  const id = blindId(claimId);
  const tomb = activitySeams.activeTomb();
  if (!id || !tomb || !remember(`drop-revoked:${id}`)) return;
  const metadata: JsonObject = { claimId: id };
  write(
    tomb,
    {
      category: "vault",
      type: "vault.drop.revoked",
      summary: "Drop revoked",
      outcome: "succeeded",
      targetType: "claim",
      targetId: id,
      metadata,
    },
    "drop.revoked",
    { claimId: id },
  );
}

/** The owner ended the live session for everyone on this tab. */
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

/** The owner let this guest in. Ids only: the session, and the request. */
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

const GRANT_RECEIPT_KIND: readonly ReceiptKind[] = [
  "share.approved",
  "share.denied",
];

/** Identity share grant decision after a person approves or denies. */
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

/** A person granted or revoked a share. The label stays on the share, not here. */
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
