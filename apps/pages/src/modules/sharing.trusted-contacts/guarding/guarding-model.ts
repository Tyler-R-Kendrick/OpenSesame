/**
 * What a guardian's sheets say about the documents they were handed: the
 * facts of an invitation and of a request, and the mark for where a request
 * stands. Pure, so a test can read every state without drawing one.
 *
 * Nothing here reads a key or a share. A fingerprint is the short name of a
 * public key, the one two people can check against each other by voice, and
 * every other fact is a field the signed policy or the request itself carries.
 */

import type {
  InviteView,
  NoticeOutcome,
  Phase,
  RequestView,
  Taken,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { CeremonyFact } from "../../../components/CeremonyShell.js";
import { type Mark, when } from "../row-model.js";

/** The most a name can be: the enrollment schema's own limit. */
export const NAME_MAX = 120;

/** What an invitation says, before anything is agreed to. */
export function inviteFacts(view: InviteView): CeremonyFact[] {
  return [
    { key: "Owner key", value: view.ownerFingerprint },
    { key: "Origins", value: view.invite.origins.join(", ") },
    { key: "Expires", value: when(view.invite.expiresAt) },
  ];
}

/** Where to open an invitation this page is not one of the origins of. */
export function originMark(view: InviteView): Mark {
  const [first] = view.invite.origins;
  return {
    tone: "err",
    label: `Open this invitation at ${first ?? "one of the circle's origins"}`,
  };
}

/** What a request asks, as the guardian's own policy read it; the sentence is the name of the card. */
export function requestFacts(view: RequestView): CeremonyFact[] {
  return [
    { key: "Circle", value: view.circleLabel },
    { key: "Operation", value: view.operation },
    { key: "For", value: view.recipientLabel },
    { key: "Recipient key", value: view.recipientFingerprint },
    { key: "Approve by", value: when(view.approveBy) },
    { key: "Releases from", value: when(view.releasableAt) },
    { key: "Expires", value: when(view.expiresAt) },
  ];
}

export function phaseMark(phase: Phase): Mark {
  switch (phase) {
    case "approve":
      return { tone: "ok", label: "Open for approval" };
    case "wait":
      return { tone: "idle", label: "Waiting for the delay" };
    case "release":
      return { tone: "ok", label: "Ready to release" };
    case "over":
      return { tone: "idle", label: "Closed" };
    case "cancelled":
      return { tone: "idle", label: "Cancelled by the owner" };
  }
}

/** This guardian may release a share for this request now. */
export function mayRelease(view: RequestView): boolean {
  return view.phase === "release" && view.canRelease;
}

/** What taking a welcome left this device holding: a share to prove, or only a seat. */
export function takenMark(taken: Taken): Mark {
  return taken.receipt === null
    ? { tone: "ok", label: "Seat taken" }
    : { tone: "ok", label: "Share taken" };
}

/** What a policy that arrived by itself did to a circle this device holds, said of that circle. */
export function noticeMark(label: string, outcome: NoticeOutcome): Mark {
  switch (outcome) {
    case "retired":
      return { tone: "idle", label: `You are no longer in ${label}` };
    case "awaiting_share":
      return { tone: "warn", label: `Waiting for your new share in ${label}` };
    case "adopted":
      return { tone: "ok", label: `${label} is up to date` };
  }
}
