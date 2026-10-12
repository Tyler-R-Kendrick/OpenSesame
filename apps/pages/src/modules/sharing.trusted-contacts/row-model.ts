/**
 * What a row of Settings › Trusted contacts says about its record: the one
 * fact line under its name and the mark for where it stands. Pure, so a
 * test can read every state without drawing one.
 *
 * Nothing here reads a key, a share or a packet. A row names a circle by the
 * label its owner chose, and a person it was held for by the owner key's
 * fingerprint, the short name two people can check against each other.
 */

import type { LedgerStatus } from "@opensesame/app-core/lib/quorum/ledger-types.js";
import {
  type CircleState,
  type ShareState,
  ruleText,
} from "@opensesame/app-core/lib/quorum/records.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import type { CirclePolicy } from "@opensesame/app-core/lib/quorum/types.js";
import type { StatusTone } from "../../components/StatusMark.js";

export type Mark = Readonly<{ tone: StatusTone; label: string }>;

/** "1 circle", "3 contacts", "No recoveries". */
export function countText(
  count: number,
  noun: string,
  plural = `${noun}s`,
): string {
  if (count === 0) return `No ${plural}`;
  return count === 1 ? `1 ${noun}` : `${count} ${plural}`;
}

/** A moment as the person's own clock and locale write it. */
export function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Rule, epoch and how many contacts; "approvals only" when nothing is protected. */
export function circleFacts(policy: CirclePolicy): string {
  return [
    ruleText(policy),
    `epoch ${policy.epoch}`,
    countText(policy.guardians.length, "contact"),
    policy.operations.includes("recover-collection") ? "" : "approvals only",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function circleMark(state: CircleState): Mark {
  switch (state) {
    case "armed":
      return { tone: "ok", label: "Armed: every contact has taken their part" };
    case "inviting":
      return { tone: "idle", label: "Waiting for contacts to take their part" };
    case "recovering":
      return { tone: "warn", label: "A recovery is open on this circle" };
    case "retired":
      return { tone: "idle", label: "Retired" };
  }
}

/** Whose circle, and whether this device holds a share or only a seat. */
export function heldFacts(policy: CirclePolicy, holdsShare: boolean): string {
  return [
    `Held for ${keyFingerprint(policy.ownerKey)}`,
    holdsShare ? "share" : "seat",
    `epoch ${policy.epoch}`,
  ].join(" · ");
}

export function heldMark(state: ShareState): Mark {
  switch (state) {
    case "held":
      return { tone: "ok", label: "Held" };
    case "approved":
      return { tone: "warn", label: "Approved a request; its release is next" };
    case "released":
      return { tone: "idle", label: "Share released" };
    case "retired":
      return { tone: "idle", label: "Retired" };
  }
}

export function recoveryFacts(
  approvedBy: readonly string[],
  releasedBy: readonly string[],
): string {
  return `${approvedBy.length} approved · ${releasedBy.length} released`;
}

export function recoveryMark(status: LedgerStatus): Mark {
  switch (status.state) {
    case "collecting":
      return {
        tone: "idle",
        label: `Collecting approvals until ${when(status.closesAt)}`,
      };
    case "approval_closed":
      return { tone: "warn", label: "Approvals closed before enough came in" };
    case "waiting":
      return {
        tone: "idle",
        label: `Releases open ${when(status.releasableAt)}`,
      };
    case "releasable":
      return {
        tone: "ok",
        label: `Releases are open until ${when(status.until)}`,
      };
    case "complete":
      return { tone: "ok", label: "Complete" };
    case "authorized":
      return { tone: "ok", label: `Authorized until ${when(status.until)}` };
    case "executed":
      return { tone: "ok", label: "Done" };
    case "cancelled":
      return { tone: "err", label: "Cancelled by the owner" };
    case "expired":
      return { tone: "err", label: "Expired" };
  }
}
