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
const transitions: Readonly<
  Record<PresentationState, readonly PresentationState[]>
> = {
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
};

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
  if (terminal.has(session.state) || !transitions[session.state].includes(to)) {
    throw new PresentationTransitionError(session.state, to);
  }
  if (to !== "expired" && session.expiresAt <= now) {
    throw new PresentationTransitionError(session.state, "expired");
  }
  return {
    ...session,
    state: to,
    ...(to === "consented" ? { consentedAt: now } : {}),
    ...(to === "activated" ? { activatedAt: now } : {}),
    ...(to === "completed" ? { completedAt: now } : {}),
    version: session.version + 1,
  };
}
