/**
 * What the join ceremony holds (ADR 0136): its dependencies, and every value
 * it keeps between presses, seeded from a held offer or an arriving invite.
 */
import type { PairingPrompt } from "@opensesame/app-core/lib/browser-pairing.js";
import {
  type JoinError,
  type JoinErrorCode,
  askToJoin,
  beginApproval,
  claimInvite,
  configuredEndpoint,
  endJoinAuthority,
  joinAvailable,
  keepJoinAuthority,
  listOpenSessions,
  pollApproval,
  presentInvite,
  verifyAt,
} from "@opensesame/app-core/lib/join/client.js";
import { initialSelection } from "@opensesame/app-core/lib/join/consent.js";
import type { CapturedInvite } from "@opensesame/app-core/lib/join/invite.js";
import {
  forgetPresented,
  markPresented,
  wasPresented,
} from "@opensesame/app-core/lib/join/presented.js";
import {
  clearPendingJoin,
  readPendingJoin,
  writePendingJoin,
} from "@opensesame/app-core/lib/join/stash.js";
import type {
  JoinOffer,
  JoinReceipt,
  OpenSession,
} from "@opensesame/app-core/lib/join/wire.js";
import { completeSetup, loadSetup } from "@opensesame/app-core/lib/setup.js";
import type {
  JoinRoad,
  JoinStep,
} from "@opensesame/app-core/screens/join/join-model.js";
import { useRef, useState } from "react";

export const joinCeremonyDependencies = {
  joinAvailable,
  configuredEndpoint,
  presentInvite,
  beginApproval,
  pollApproval,
  verifyAt,
  claimInvite,
  listOpenSessions,
  askToJoin,
  endJoinAuthority,
  keepJoinAuthority,
  readPendingJoin,
  writePendingJoin,
  clearPendingJoin,
  wasPresented,
  markPresented,
  forgetPresented,
  completeSetup,
  loadSetup,
};

export const deps = joinCeremonyDependencies;

/** A looked-up offer, and the endpoint and invite it belongs to. */
export type Offered = { endpoint: string; token: string; offer: JoinOffer };

/** Answers that mean the offer is gone for good: nothing to keep for it. */
export const DEAD: readonly JoinErrorCode[] = [
  "invite_unknown",
  "invite_spent",
  "invite_expired",
];

/** A failure's code; anything that is not a join error reads as silence. */
export function codeOf(error: JoinError | null): JoinErrorCode {
  return error?.code ?? "unreachable";
}

export function firstError(
  captured: CapturedInvite | null,
): JoinErrorCode | null {
  if (captured?.kind === "leaked") return "leaked_invite";
  if (!deps.joinAvailable()) return "unavailable_here";
  return null;
}

function useLatch<T>(initial: T | (() => T)) {
  const [value, set] = useState<T>(initial);
  return { value, set };
}

/** Every value the ceremony holds, seeded from a held offer or an arrival. */
export function useJoinFields(captured: CapturedInvite | null) {
  const arrived = captured?.kind === "invite" ? captured.invite : null;
  // A looked-up offer this tab still holds resumes where it stopped — unless
  // a different invite just arrived, which starts its own ceremony.
  const [pending] = useState(() => {
    const held = deps.readPendingJoin();
    return held && (!arrived || arrived.token === held.token) ? held : null;
  });
  return {
    road: useLatch<JoinRoad>("invite"),
    // Authority lives in memory, so even a held offer starts from the top:
    // approval and verification again, then the offer — never presented twice.
    step: useLatch<JoinStep>("where"),
    endpoint: useLatch(
      () => pending?.endpoint ?? arrived?.endpoint ?? deps.configuredEndpoint(),
    ),
    inviteText: useLatch(() => pending?.token ?? arrived?.token ?? ""),
    offered: useLatch<Offered | null>(() => pending),
    selection: useLatch<ReadonlySet<string>>(() =>
      pending ? initialSelection(pending.offer) : new Set(),
    ),
    prompt: useLatch<PairingPrompt | null>(null),
    code: useLatch(""),
    sessions: useLatch<OpenSession[] | null>(null),
    sessionId: useLatch(""),
    note: useLatch(""),
    receipt: useLatch<JoinReceipt | null>(null),
    claimed: useLatch(0),
    busy: useLatch(false),
    error: useLatch<JoinErrorCode | null>(() => firstError(captured)),
    lifetime: useRef(new AbortController()),
  };
}

export type Fields = ReturnType<typeof useJoinFields>;
