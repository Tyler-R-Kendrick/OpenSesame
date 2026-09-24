/**
 * The join ceremony's ladder and words (ADR 0136) — no React, no DOM.
 *
 * Two roads in, one ladder each:
 *
 * - **invite** — somebody made an offer: a link and a code. Where →
 *   approval → verify → what you'd get (looked up, then chosen item by item)
 *   → code → joined. The endpoint shows a browser nothing before approval
 *   and verification, so the offer is looked up — and spent — only once
 *   this browser can go on to accept it.
 * - **open** — a session anyone may ask into, at an endpoint the person
 *   names. Where → approval → verify → which session → asked.
 *
 * Approval is the endpoint's operator admitting this browser; verify is the
 * person proving, by passkey, that they are who the operator admitted. Both
 * exist on the endpoint already — the ceremony only walks them in order.
 */

import type { JoinErrorCode } from "../../lib/join/client.js";

export type JoinRoad = "invite" | "open";

export type JoinStep =
  | "where"
  | "review"
  | "approve"
  | "verify"
  | "accept"
  | "ask"
  | "done";

const LADDERS = {
  invite: ["where", "approve", "verify", "review", "accept", "done"],
  open: ["where", "approve", "verify", "ask", "done"],
} as const satisfies Readonly<Record<JoinRoad, readonly JoinStep[]>>;

export function joinSteps(road: JoinRoad): readonly JoinStep[] {
  return LADDERS[road];
}

export function nextJoinStep(road: JoinRoad, step: JoinStep): JoinStep {
  const ladder = joinSteps(road);
  const at = ladder.indexOf(step);
  return ladder[Math.min(at + 1, ladder.length - 1)] ?? "done";
}

/** The rail's short names. */
export const JOIN_RAIL = {
  where: "Where",
  review: "Offer",
  approve: "Approval",
  verify: "Verify",
  accept: "Code",
  ask: "Session",
  done: "Joined",
} as const satisfies Readonly<Record<JoinStep, string>>;

export const JOIN_TITLE = {
  where: "Join a session",
  review: "What you would get",
  approve: "Approval",
  verify: "Verify it is you",
  accept: "The code",
  ask: "Which session",
  done: "Joined",
} as const satisfies Readonly<Record<JoinStep, string>>;

/** The `.go` verb for a step — its accessible name and the word beside it. */
export function joinVerb(
  road: JoinRoad,
  step: JoinStep,
  state: Readonly<{
    busy: boolean;
    waiting: boolean;
    asked: boolean;
    offered: boolean;
  }>,
): string {
  if (state.waiting) return "Waiting for approval…";
  if (state.busy) return "Working…";
  switch (step) {
    case "where":
      return "Continue";
    case "review":
      return state.offered ? "Continue with these" : "Look up the invite";
    case "approve":
      return "Ask for approval";
    case "verify":
      return "Verify with a passkey";
    case "accept":
      return "Join";
    case "ask":
      return "Ask to join";
    case "done":
      return state.asked ? "Close" : "Finish";
  }
}

const ERROR_TEXT = {
  unavailable_here:
    "This address cannot finish a join. Open the invite on your organization's own OpenSesame address.",
  bad_endpoint: "Use an https address, or http on this computer.",
  bad_invite: "That is not an invite link or token.",
  leaked_invite:
    "That link carried its token where servers log it. Ask the sender for a fresh invite.",
  unreachable: "The endpoint did not answer.",
  invite_unknown: "No invite by that link. Ask the sender for a fresh one.",
  invite_spent:
    "That invite was already opened, so it is cancelled. If that was not you, tell the sender: the link may have leaked.",
  invite_expired: "That invite expired. Ask the sender for a fresh one.",
  code_format: "The code is eight letters, like BCDF-GHJK.",
  code_mismatch:
    "That code did not match. A few more misses cancel the invite.",
  claim_refused: "The endpoint refused that choice.",
  approval_failed: "The endpoint refused to approve this browser.",
  approval_expired: "Approval lapsed. Ask again.",
  verify_needs_identity:
    "Verifying needs this deployment's sign-in service, and none is configured.",
  verify_failed: "Verification was refused or expired.",
  note_too_long: "Keep the note under 280 characters.",
  no_session: "No open session by that id.",
  already_member: "You are already in that session.",
  already_asked: "Your request is already waiting.",
  invalid_response: "The endpoint's answer was not one this page accepts.",
} as const satisfies Readonly<Record<JoinErrorCode, string>>;

export function joinErrorText(code: JoinErrorCode): string {
  return ERROR_TEXT[code];
}

/** Which field an error belongs beside; everything else sits by the commit. */
export function joinErrorField(
  code: JoinErrorCode,
): "endpoint" | "invite" | "code" | "session" | "note" | null {
  switch (code) {
    case "bad_endpoint":
      return "endpoint";
    case "bad_invite":
    case "leaked_invite":
      return "invite";
    case "code_format":
    case "code_mismatch":
      return "code";
    case "no_session":
    case "already_member":
    case "already_asked":
      return "session";
    case "note_too_long":
      return "note";
    default:
      return null;
  }
}

/**
 * How the endpoint field is marked: the deployment's own endpoint is the
 * quiet case; any other one a link or a person named is flagged, because
 * that is where a join made from a forwarded link would actually go.
 */
export function endpointMark(
  endpoint: string,
  configured: string,
): "own" | "other" | null {
  if (!endpoint) return null;
  if (!configured) return "other";
  return endpoint === configured ? "own" : "other";
}

/** "in 12 min", "in 3 h" — an offer's remaining life, never a timestamp. */
export function joinExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return "not stated";
  const minutes = Math.round((expiresAt - now) / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 90) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}
