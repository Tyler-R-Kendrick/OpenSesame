import { APPROVAL_WORDS } from "./approval-copy.js";
import {
  ApprovalError,
  type ApprovalRefusal,
  approvalWords,
} from "./approval-words.js";
import type {
  ApprovalRequirement,
  ApprovalVerb,
  AuthorizationRequestClient,
  AuthorizationRequestView,
} from "./authorization-request-client.js";
import {
  type InteractionAuthenticator,
  InteractionStepUpError,
} from "./interaction-approval.js";

/**
 * The authorization-request review (ADR 0084; ADR 0140 plan step 6): load →
 * review → decide or report → outcome, as steps a surface asks for and phases
 * it draws. What the retired ceremonies app's `ApprovalReview.tsx` did in its
 * component, now Pages' `/approve/:ref` over this one model.
 * No React, no page, no global: the client and the authenticator are injected
 * (the authenticator is the interaction ceremony's port — the same WebAuthn
 * request options in, the same raw assertion out).
 *
 * The bindings, in the order they happen, and not rearranged:
 *   - the digest first shown is frozen; every call echoes exactly it, and a
 *     re-read that shows another one is refused before any call;
 *   - the requirement's policy digest is frozen with it. An activation
 *     challenge minted under another policy is refused before the person is
 *     asked for a passkey — they read "why this one asks for more" about the
 *     policy that was shown, not one that changed under them;
 *   - an explicit confirmation precedes an approval: one tap that both reads
 *     and signs is a tap that can be phished into meaning anything;
 *   - a required comparison code is six digits before any call, travels in
 *     the settle body only, and is never kept or read back;
 *   - a required activation is minted naming the digest and the verb, the
 *     authenticator runs over the authority's options unaltered, the raw
 *     assertion is verified by the authority, and the settle names that same
 *     activation — which the server spends by compare-and-set. An activation
 *     the server confirms under any other id is refused. A browser that
 *     cannot run the authenticator is told so; the step is never skipped;
 *   - a report is not a denial: it refuses the request and records that the
 *     person did not recognise it.
 */

export interface ApprovalReviewDeps {
  client: AuthorizationRequestClient;
  authenticator: InteractionAuthenticator;
}

/** How a review ended, for the screen that ends it. */
export type ApprovalEnding =
  | { kind: "approved"; words: string }
  | { kind: "denied"; words: string }
  | { kind: "reported"; title: string; words: string }
  | { kind: "ended"; title: string; words: string };

export type ApprovalPhase =
  | { kind: "loading" }
  /** Loading failed without ending anything: offer `load` again. */
  | { kind: "stalled" }
  | {
      kind: "review";
      request: AuthorizationRequestView;
      requirement: ApprovalRequirement;
    }
  | { kind: "done"; ending: ApprovalEnding };

/**
 * A phase and what to tell the person. `alarm` marks the one message that is
 * a security signal rather than a problem to fix: a comparison code that did
 * not match, which may mean somebody else started this request.
 */
export type ApprovalStep = {
  phase: ApprovalPhase;
  message: string | null;
  alarm: boolean;
};

/** What a decision carries in from the screen; kept for this call only. */
export interface DecisionInput {
  /** The person said they read it and mean exactly that. Approve only. */
  confirmed?: boolean;
  /** The six-digit code, when the requirement asks for one. */
  comparison?: string;
}

type Review = Extract<ApprovalPhase, { kind: "review" }>;

type Ceremony = {
  readonly deps: ApprovalReviewDeps;
  readonly id: string;
  phase: ApprovalPhase;
  /** The request digest and policy digest first put in front of a person. */
  shown: { digest: string; policy: string } | null;
  busy: boolean;
  run: number;
};

const COMPARISON = /^[0-9]{6}$/;

function step(
  phase: ApprovalPhase,
  message: string | null,
  alarm = false,
): ApprovalStep {
  return { phase, message, alarm };
}

function ended(refusal: ApprovalRefusal, title: string): ApprovalStep {
  return step(
    { kind: "done", ending: { kind: "ended", title, words: refusal.words } },
    null,
  );
}

/** Where a refusal leaves the screen, from `from`. */
function refused(
  error: Error | null,
  from: ApprovalPhase,
  title: string,
): ApprovalStep {
  const refusal =
    error instanceof ApprovalError
      ? { kind: error.kind, words: error.message, ends: error.ends }
      : approvalWords("failed");
  if (refusal.ends) return ended(refusal, title);
  const stay = from.kind === "loading" ? { kind: "stalled" as const } : from;
  return step(stay, refusal.words, refusal.kind === "comparison_mismatch");
}

function commit(ceremony: Ceremony, next: ApprovalStep): ApprovalStep {
  ceremony.phase = next.phase;
  if (next.phase.kind === "review") {
    ceremony.shown ??= {
      digest: next.phase.request.requestDigest,
      policy: next.phase.requirement.policyDigest,
    };
  }
  return next;
}

/** The words for a request that is not the one that was shown. */
const CHANGED = approvalWords("changed");

/**
 * The review a read opens, or its end. Said on arrival, not only when a
 * button is pressed: a person coming back to a request rewritten under them,
 * or judged under other rules, reads that before reaching for it — and a
 * fresh review is the only way to decide the new version.
 */
function reread(
  ceremony: Ceremony,
  request: AuthorizationRequestView,
  requirement: ApprovalRequirement,
): ApprovalStep {
  const { shown } = ceremony;
  if (shown !== null && shown.digest !== request.requestDigest) {
    return ended(CHANGED, APPROVAL_WORDS.endedOnLoad);
  }
  if (shown !== null && shown.policy !== requirement.policyDigest) {
    return ended(approvalWords("policy_changed"), APPROVAL_WORDS.endedOnLoad);
  }
  return step({ kind: "review", request, requirement }, null);
}

async function load(ceremony: Ceremony): Promise<ApprovalStep | null> {
  if (ceremony.phase.kind === "done" || ceremony.busy) return null;
  const id = ++ceremony.run;
  const loading: ApprovalPhase = { kind: "loading" };
  ceremony.phase = loading;
  let next: ApprovalStep;
  try {
    const { client } = ceremony.deps;
    const request = await client.read(ceremony.id);
    const requirement = await client.requirement(ceremony.id);
    next = reread(ceremony, request, requirement);
  } catch (error) {
    const thrown = error instanceof Error ? error : null;
    next = refused(thrown, loading, APPROVAL_WORDS.endedOnLoad);
  }
  return id === ceremony.run ? commit(ceremony, next) : null;
}

/** Refuse before any call what the server would refuse after a passkey. */
function precheck(
  ceremony: Ceremony,
  review: Review,
  verb: ApprovalVerb,
  input: DecisionInput,
): string | null {
  if (ceremony.shown?.digest !== review.request.requestDigest) {
    return CHANGED.words;
  }
  if (verb === "approve" && input.confirmed !== true) {
    return APPROVAL_WORDS.confirmNeeded;
  }
  const { requirement } = review;
  if (
    requirement.requireComparison &&
    !COMPARISON.test(input.comparison ?? "")
  ) {
    return APPROVAL_WORDS.comparisonNeeded;
  }
  if (
    requirement.requireTransactionBoundActivation &&
    !ceremony.deps.authenticator.available()
  ) {
    return APPROVAL_WORDS.noCredentialsApi;
  }
  return null;
}

/** An activation that must not be settled with, and why. */
type Unusable = "policy_changed" | "activation_failed";

/**
 * Mint, prove, confirm. A challenge minted under another policy stops before
 * the authenticator is asked; an activation the authority confirms under
 * another id stops before the settle.
 */
async function activate(
  ceremony: Ceremony,
  verb: ApprovalVerb,
  digest: string,
): Promise<{ id: string } | Unusable> {
  const { client, authenticator } = ceremony.deps;
  const challenge = await client.beginActivation(ceremony.id, verb, digest);
  if (challenge.policyDigest !== ceremony.shown?.policy)
    return "policy_changed";
  const assertion = await authenticator.assert(challenge.options);
  const confirmed = await client.completeActivation(
    ceremony.id,
    challenge.activationId,
    assertion,
  );
  return confirmed === challenge.activationId
    ? { id: challenge.activationId }
    : "activation_failed";
}

async function settle(
  ceremony: Ceremony,
  review: Review,
  verb: ApprovalVerb,
  comparison: string | undefined,
): Promise<ApprovalStep> {
  const digest = review.request.requestDigest;
  const { requirement } = review;
  let activationId: string | undefined;
  if (requirement.requireTransactionBoundActivation) {
    const begun = await activate(ceremony, verb, digest);
    // The rules changed under the person: what they read no longer holds.
    if (begun === "policy_changed") {
      return ended(approvalWords(begun), APPROVAL_WORDS.endedOnDecide);
    }
    if (begun === "activation_failed") {
      return step(review, approvalWords(begun).words);
    }
    activationId = begun.id;
  }
  await ceremony.deps.client.settle(ceremony.id, verb, {
    requestDigest: digest,
    ...(activationId ? { activationId } : undefined),
    ...(requirement.requireComparison && comparison !== undefined
      ? { comparisonValue: comparison }
      : undefined),
  });
  const ending: ApprovalEnding =
    verb === "approve"
      ? { kind: "approved", words: APPROVAL_WORDS.approved }
      : { kind: "denied", words: APPROVAL_WORDS.denied };
  return step({ kind: "done", ending }, null);
}

async function decide(
  ceremony: Ceremony,
  verb: ApprovalVerb,
  input: DecisionInput,
): Promise<ApprovalStep | null> {
  const review = ceremony.phase;
  if (review.kind !== "review" || ceremony.busy) return null;
  const stop = precheck(ceremony, review, verb, input);
  if (stop !== null) return commit(ceremony, step(review, stop));
  ceremony.busy = true;
  ceremony.run++;
  try {
    const comparison = input.comparison?.trim();
    return commit(ceremony, await settle(ceremony, review, verb, comparison));
  } catch (error) {
    if (error instanceof InteractionStepUpError) {
      return commit(ceremony, step(review, error.message));
    }
    const thrown = error instanceof Error ? error : null;
    return commit(
      ceremony,
      refused(thrown, review, APPROVAL_WORDS.endedOnDecide),
    );
  } finally {
    ceremony.busy = false;
  }
}

async function report(ceremony: Ceremony): Promise<ApprovalStep | null> {
  const review = ceremony.phase;
  if (review.kind !== "review" || ceremony.busy) return null;
  const digest = ceremony.shown?.digest ?? review.request.requestDigest;
  ceremony.busy = true;
  ceremony.run++;
  try {
    await ceremony.deps.client.report(ceremony.id, digest);
    const ending: ApprovalEnding = {
      kind: "reported",
      title: APPROVAL_WORDS.reportedTitle,
      words: APPROVAL_WORDS.reported,
    };
    return commit(ceremony, step({ kind: "done", ending }, null));
  } catch (error) {
    const thrown = error instanceof Error ? error : null;
    return commit(
      ceremony,
      refused(thrown, review, APPROVAL_WORDS.endedOnLoad),
    );
  } finally {
    ceremony.busy = false;
  }
}

/**
 * One review for one request id. Every method answers with the step to draw,
 * or `null` when it had nothing to say: a repeat while a call is in flight, a
 * call after the review ended, or a read a later call superseded.
 */
export function createApprovalReview(deps: ApprovalReviewDeps, id: string) {
  const ceremony: Ceremony = {
    deps,
    id,
    phase: { kind: "loading" },
    shown: null,
    busy: false,
    run: 0,
  };
  return {
    phase: (): ApprovalPhase => ceremony.phase,
    load: () => load(ceremony),
    approve: (input: DecisionInput) => decide(ceremony, "approve", input),
    deny: (input: DecisionInput = {}) => decide(ceremony, "deny", input),
    report: () => report(ceremony),
  };
}

export type ApprovalReview = ReturnType<typeof createApprovalReview>;
