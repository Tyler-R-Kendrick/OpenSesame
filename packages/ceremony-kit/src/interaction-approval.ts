import type {
  InteractionDetail,
  InteractionSummary,
  JsonObject,
} from "@opensesame/os-domain";
import type { InteractionClient } from "./interaction-client.js";
import { InteractionError } from "./interaction-error.js";
import {
  type ApprovalView,
  INTERACTION_WORDS,
  type InteractionRefusal,
  type Mechanism,
  type Outcome,
  chooseMechanism,
  interactionRefusal,
  outcomeOfStatus,
  viewOf,
} from "./interaction-outcome.js";

/**
 * The cross-device approval ceremony (ADR 0086; ADR 0140 plan step 5):
 * load → review → activate → decide → outcome, as steps a surface asks for
 * and phases it draws. One model for what `apps/mobile-mfa`'s `Approval.tsx`
 * did in its component, so the phone and Pages cannot disagree about it. No
 * React, no page, no global: the interaction client and the authenticator are
 * injected.
 *
 * The bindings it keeps (ADR 0084, ADR 0086 §4 and §7):
 *   - the digest first shown is frozen; an answer echoes exactly it, and a
 *     request that changed, or never carried one, is refused before any call
 *     — before the person is asked for a passkey;
 *   - an approval begins an activation naming the digest and the verb
 *     (`approved`), runs the authenticator against the authority's options
 *     unaltered, hands the raw assertion back to be verified, and approves
 *     naming that same activation — the server binds the policy digest into
 *     the challenge and spends the activation by compare-and-set;
 *   - an activation the server confirms under any other id is refused, and a
 *     failed step-up never degrades into an approve without one;
 *   - a deny echoes the digest and needs no proof: authority only shrinks;
 *   - resolving the link is unauthenticated (the client's job), and the
 *     approver's view is read only after that.
 */

/** The raw assertion an authenticator produced: inputs, never a proof. */
export interface InteractionAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export type StepUpFailure =
  | "unavailable"
  | "cancelled"
  | "invalid_options"
  | "invalid_credential";

export const STEP_UP_WORDS = {
  unavailable: "Needs a passkey. This device has none.",
  cancelled: "Passkey cancelled. Nothing was approved.",
  invalid_options: "Passkey options were invalid. Nothing was approved.",
  invalid_credential:
    "Passkey returned an invalid credential. Nothing was approved.",
} as const satisfies Record<StepUpFailure, string>;

/** A step-up that produced no assertion. Nothing reached the wire after it. */
export class InteractionStepUpError extends Error {
  readonly reason: StepUpFailure;
  constructor(reason: StepUpFailure) {
    super(STEP_UP_WORDS[reason]);
    this.name = "InteractionStepUpError";
    this.reason = reason;
  }
}

/**
 * The platform authenticator, as the ceremony needs it. `assert` runs it
 * against the authority's interaction-scoped options exactly as issued — their
 * challenge is bound server-side to this request, verb and policy — and throws
 * `InteractionStepUpError` for every failure, cancellation included.
 */
export interface InteractionAuthenticator {
  available(): boolean;
  assert(options: JsonObject): Promise<InteractionAssertion>;
}

export interface InteractionApprovalDeps {
  client: InteractionClient;
  authenticator: InteractionAuthenticator;
  /** Whether the surface holds a session to read the approver's view with. */
  signedIn(): boolean;
}

export type InteractionPhase =
  | { kind: "loading" }
  /** Loading failed without ending anything: offer `load` again. */
  | { kind: "stalled" }
  | { kind: "signin"; expiresAt?: Date }
  | {
      kind: "review";
      detail: InteractionDetail;
      view: ApprovalView;
      /** `undefined`: this device cannot approve; deny stays available. */
      mechanism: Mechanism | undefined;
    }
  | { kind: "done"; outcome: Outcome };

/** A phase and what to tell the person about it, if anything. */
export type InteractionStep = {
  phase: InteractionPhase;
  message: string | null;
};

type Review = Extract<InteractionPhase, { kind: "review" }>;

/** One ceremony's state: what it last answered and what it has shown. */
type Ceremony = {
  readonly deps: InteractionApprovalDeps;
  readonly ref: string;
  phase: InteractionPhase;
  /** The digest this screen put in front of a person, frozen once. */
  shown: string | null;
  /** A decision in flight: reads wait, a second decision is ignored. */
  deciding: boolean;
  /** Which operation may still speak; a superseded read stays silent. */
  run: number;
};

function refusalOf(error: Error | null): InteractionRefusal {
  if (error instanceof InteractionError) {
    return interactionRefusal(error.declared || error.code, error.status);
  }
  return interactionRefusal("interaction_unavailable", 0);
}

function step(
  phase: InteractionPhase,
  message: string | null,
): InteractionStep {
  return { phase, message };
}

/** The words for a request that cannot be answered as shown. */
function changedWords(detail: InteractionDetail): string {
  return detail.requestDigest === undefined
    ? INTERACTION_WORDS.unanswerable
    : interactionRefusal("digest_mismatch", 409).words;
}

function commit(ceremony: Ceremony, next: InteractionStep): InteractionStep {
  ceremony.phase = next.phase;
  const { phase } = next;
  const digest = phase.kind === "review" ? phase.detail.requestDigest : null;
  ceremony.shown ??= digest ?? null;
  return next;
}

function commitIf(
  ceremony: Ceremony,
  id: number,
  next: InteractionStep,
): InteractionStep | null {
  return id === ceremony.run ? commit(ceremony, next) : null;
}

function opened(
  ceremony: Ceremony,
  detail: InteractionDetail,
): InteractionStep {
  const settled = outcomeOfStatus(detail.status);
  if (settled) return step({ kind: "done", outcome: settled }, null);
  const digest = detail.requestDigest ?? null;
  const frozen = ceremony.shown ?? digest;
  // Said now, not only when a button is pressed: a person coming back to a
  // request rewritten under them reads that before reaching for it.
  const message =
    frozen !== null && frozen === digest ? null : changedWords(detail);
  const mechanism = chooseMechanism(ceremony.deps.authenticator.available());
  const view = viewOf(detail);
  return step({ kind: "review", detail, view, mechanism }, message);
}

/** Where a refusal leaves the screen, from `from`; not yet committed. */
async function refused(
  ceremony: Ceremony,
  error: Error | null,
  from: InteractionPhase,
  again: boolean,
): Promise<InteractionStep> {
  const refusal = refusalOf(error);
  if (refusal.outcome) {
    return step({ kind: "done", outcome: refusal.outcome }, null);
  }
  // A decision already stands: read it back to say which one.
  if (refusal.kind === "settled" && again) {
    return readStep(ceremony, from, refusal.words);
  }
  if (refusal.kind === "signin") {
    const signedIn = ceremony.deps.signedIn();
    const words = signedIn ? INTERACTION_WORDS.sessionRefused : null;
    return step(from.kind === "signin" ? from : { kind: "signin" }, words);
  }
  const stay = from.kind === "loading" ? { kind: "stalled" as const } : from;
  return step(stay, refusal.words);
}

async function readStep(
  ceremony: Ceremony,
  from: InteractionPhase,
  fallback: string | null,
): Promise<InteractionStep> {
  try {
    return opened(
      ceremony,
      await ceremony.deps.client.readInteraction(ceremony.ref),
    );
  } catch (error) {
    const thrown = error instanceof Error ? error : null;
    const next = await refused(ceremony, thrown, from, false);
    return next.message === null && fallback
      ? step(next.phase, fallback)
      : next;
  }
}

/** The digest an answer may echo, or `undefined` when none may be sent. */
function echoable(
  ceremony: Ceremony,
  detail: InteractionDetail,
): string | undefined {
  const { shown } = ceremony;
  return shown !== null && detail.requestDigest === shown ? shown : undefined;
}

/**
 * Begin an activation bound to the digest and the verb, run the
 * authenticator, and have the authority verify the raw assertion. `null`
 * when the authority confirmed an activation other than the one begun.
 */
async function activate(
  ceremony: Ceremony,
  digest: string,
): Promise<string | null> {
  const { client, authenticator } = ceremony.deps;
  const challenge = await client.beginInteractionActivation(ceremony.ref, {
    requestDigest: digest,
  });
  const assertion = await authenticator.assert(challenge.options);
  const confirmed = await client.completeInteractionActivation(ceremony.ref, {
    activationId: challenge.activationId,
    ...assertion,
  });
  return confirmed.activationId === challenge.activationId
    ? challenge.activationId
    : null;
}

function settledBy(detail: InteractionDetail, fallback: Outcome) {
  const outcome = outcomeOfStatus(detail.status) ?? fallback;
  return step({ kind: "done", outcome }, null);
}

async function answer(
  ceremony: Ceremony,
  verb: "approve" | "deny",
  review: Review,
  digest: string,
): Promise<InteractionStep> {
  const { client } = ceremony.deps;
  try {
    if (verb === "deny") {
      // No proof: refusing costs nothing to prove, and authority shrinks.
      const denied = await client.denyInteraction(ceremony.ref, {
        requestDigest: digest,
      });
      return settledBy(denied, "denied");
    }
    const activationId = await activate(ceremony, digest);
    // Never a bare approve: without the activation begun here, stop.
    if (activationId === null) return step(review, INTERACTION_WORDS.stepup);
    const approved = await client.approveInteraction(ceremony.ref, {
      requestDigest: digest,
      activationId,
    });
    return settledBy(approved, "approved");
  } catch (error) {
    if (error instanceof InteractionStepUpError) {
      return step(review, error.message);
    }
    const thrown = error instanceof Error ? error : null;
    return refused(ceremony, thrown, review, true);
  }
}

async function decide(
  ceremony: Ceremony,
  verb: "approve" | "deny",
): Promise<InteractionStep | null> {
  const review = ceremony.phase;
  if (review.kind !== "review" || ceremony.deciding) return null;
  // Checked before any call, and so before the person is asked for a
  // passkey: the server refuses a mismatch anyway (`digest_mismatch`), and
  // this keeps them from paying a biometric prompt for that refusal.
  const digest = echoable(ceremony, review.detail);
  if (digest === undefined) {
    return commit(ceremony, step(review, changedWords(review.detail)));
  }
  if (verb === "approve" && review.mechanism === undefined) {
    return commit(ceremony, step(review, STEP_UP_WORDS.unavailable));
  }
  ceremony.deciding = true;
  ceremony.run++;
  try {
    return commit(ceremony, await answer(ceremony, verb, review, digest));
  } finally {
    ceremony.deciding = false;
  }
}

/** Resolve the link, unauthenticated; then read, or ask for a sign-in. */
async function load(ceremony: Ceremony): Promise<InteractionStep | null> {
  if (ceremony.phase.kind === "done" || ceremony.deciding) return null;
  const id = ++ceremony.run;
  const loading: InteractionPhase = { kind: "loading" };
  ceremony.phase = loading;
  let summary: InteractionSummary;
  try {
    summary = await ceremony.deps.client.resolveInteraction(ceremony.ref);
  } catch (error) {
    const thrown = error instanceof Error ? error : null;
    return commitIf(
      ceremony,
      id,
      await refused(ceremony, thrown, loading, false),
    );
  }
  if (id !== ceremony.run) return null;
  const settled = outcomeOfStatus(summary.status);
  if (settled)
    return commit(ceremony, step({ kind: "done", outcome: settled }, null));
  // Scanning is not approving: the summary says a question exists and
  // nothing about what it asks. The approver's view needs a session.
  if (summary.requiresApprover && !ceremony.deps.signedIn()) {
    const signin: InteractionPhase = {
      kind: "signin",
      expiresAt: summary.expiresAt,
    };
    return commit(ceremony, step(signin, null));
  }
  return commitIf(ceremony, id, await readStep(ceremony, loading, null));
}

/**
 * Read the approver's view: after signing in, and again whenever the screen
 * comes back into view — which is what makes the frozen digest fire.
 */
async function read(ceremony: Ceremony): Promise<InteractionStep | null> {
  const { phase } = ceremony;
  if (phase.kind === "done" || ceremony.deciding) return null;
  if (phase.kind === "signin" && !ceremony.deps.signedIn()) {
    return commit(ceremony, step(phase, INTERACTION_WORDS.signInFirst));
  }
  const id = ++ceremony.run;
  return commitIf(ceremony, id, await readStep(ceremony, phase, null));
}

/**
 * One ceremony for one reference. Every method answers with the step to draw,
 * or `null` when it had nothing to say: a repeat while a decision is in
 * flight, a call after the question ended, or a read a later call superseded.
 */
export function createInteractionApproval(
  deps: InteractionApprovalDeps,
  ref: string,
) {
  const ceremony: Ceremony = {
    deps,
    ref,
    phase: { kind: "loading" },
    shown: null,
    deciding: false,
    run: 0,
  };
  return {
    /** The phase last answered, for a surface that re-renders on its own. */
    phase: (): InteractionPhase => ceremony.phase,
    load: () => load(ceremony),
    read: () => read(ceremony),
    approve: () => decide(ceremony, "approve"),
    deny: () => decide(ceremony, "deny"),
  };
}

export type InteractionApproval = ReturnType<typeof createInteractionApproval>;
