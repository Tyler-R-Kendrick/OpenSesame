import type {
  PresentationSession,
  PresentationState,
} from "../presentation.js";

const terminal = new Set<PresentationState>([
  "completed",
  "denied",
  "expired",
  "revoked",
  "failed",
]);
const transitions = {
  created: ["request_validated", "denied", "expired", "failed"],
  request_validated: ["credentials_matched", "denied", "expired", "failed"],
  credentials_matched: ["consent_required", "denied", "expired", "failed"],
  consent_required: ["consented", "denied", "expired"],
  consented: ["activation_required", "denied", "expired"],
  activation_required: ["activated", "denied", "expired"],
  activated: ["signed", "failed", "expired"],
  signed: ["delivered", "failed", "expired"],
  delivered: ["completed", "failed"],
  completed: [],
  denied: [],
  expired: [],
  revoked: [],
  failed: [],
} satisfies Record<PresentationState, readonly PresentationState[]>;

export class PresentationTransitionError extends Error {
  constructor(
    readonly from: PresentationState,
    readonly to: PresentationState,
  ) {
    super(`invalid presentation transition: ${from} -> ${to}`);
    this.name = "PresentationTransitionError";
  }
}

export function transitionPresentation(
  session: PresentationSession,
  to: PresentationState,
  now: Date,
): PresentationSession {
  const allowedTransitions: readonly PresentationState[] =
    transitions[session.state];
  if (terminal.has(session.state) || !allowedTransitions.includes(to)) {
    throw new PresentationTransitionError(session.state, to);
  }
  if (to !== "expired" && session.expiresAt <= now) {
    throw new PresentationTransitionError(session.state, "expired");
  }
  const next: PresentationSession = {
    ...session,
    state: to,
    version: session.version + 1,
  };
  if (to === "consented") next.consentedAt = now;
  if (to === "activated") next.activatedAt = now;
  if (to === "completed") next.completedAt = now;
  return next;
}
