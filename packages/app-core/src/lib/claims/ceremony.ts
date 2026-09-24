/**
 * The ownership-claim ceremony (ADR 0045; ADR 0140 plan step 4): present →
 * read → complete, with a guest path through a provisional principal.
 *
 * One model for what the console's `/claim` page and the ceremonies app's
 * claim page each did in their own component. No React and no page: a surface
 * asks for a step and draws the phase it gets back; the transport and the
 * stash are injected.
 *
 * The rules it keeps:
 *   - nothing is presented until there is a principal to accept as, because
 *     presenting spends the token and completing attaches ownership to
 *     whoever accepts — and it must be the same principal at both ends;
 *   - one bearer is never presented twice at once, and a superseded load
 *     never overwrites the one that replaced it;
 *   - a presented claim is read back on resume, never re-presented, and never
 *     resumed by a different account;
 *   - completion needs the consent code the claim's creator read out;
 *   - a refusal the bearer cannot come back from forgets it, and one it can
 *     keeps it — decided by the server's error code, not its status alone.
 */

import { isClaimToken } from "@opensesame/ceremony-kit";
import type { ClaimArrival } from "./link.js";
import {
  ClaimError,
  type ClaimReview,
  OPEN_CLAIM_STATES,
  buildClaimCompletion,
} from "./review.js";
import { type ClaimStashPort, claimStash } from "./stash.js";
import {
  type ClaimTransport,
  completeClaim,
  identityClaimTransport,
  presentClaim,
  readClaim,
} from "./transport.js";

export type ClaimPhase =
  /** Asking for a token: nothing is held. */
  | { kind: "token" }
  /** Holding a bearer while something outside the page is settled. */
  | {
      kind: "paused";
      token: string;
      presented: boolean;
      reason: "identity" | "retry";
    }
  /** Presented to `principalId`, waiting for the consent code. */
  | { kind: "open"; token: string; claim: ClaimReview; principalId: string }
  | { kind: "done" };

/** A phase and what to tell the person about it, if anything. */
export type ClaimStep = { phase: ClaimPhase; message: string | null };

export type ClaimOpen = Extract<ClaimPhase, { kind: "open" }>;

/** What an arrival asks of the page. */
export type ClaimStart =
  | { kind: "drop"; token: string; key: string }
  | { kind: "load"; token: string; presented: boolean }
  | { kind: "refused"; message: string }
  | { kind: "idle" };

export const CLAIM_WORDS = {
  signInFirst:
    "Sign in first. Reviewing spends this token, so nothing is presented until there is someone to accept as.",
  signInToFinish:
    "Sign in to finish reviewing this claim. It is waiting, not lost.",
  notAToken:
    "That is not a claim token. Paste the whole token, starting osc_clm_.",
  unresumable:
    "This claim was already presented and cannot be reopened here. Ask for a fresh claim link.",
  otherAccount:
    "This claim was opened by a different account in this tab. Open the claim link again to review it as yourself.",
  completed: "This claim was already completed.",
  identityChanged:
    "The account in this tab changed while this claim was open, so it was not accepted. Open the claim link again to review it as yourself.",
  needCode:
    "Enter the code the person who shared this gave you. Holding the link alone is not consent.",
  guestFailed: "Could not start a guest session. Try again.",
  leaked:
    "This claim link carried its token where it may have been logged, so it was not used. Ask for a fresh claim link.",
  loadFallback: "Could not load this claim. Check the token and try again.",
  completeFallback: "Claim could not be completed. Try again.",
} as const;

/** Why an open claim can no longer be accepted. */
export function closedClaimWords(state: string): string {
  return state === "completed"
    ? CLAIM_WORDS.completed
    : `This claim is ${state} and can no longer be accepted.`;
}

export interface ClaimCeremonyDeps {
  transport: ClaimTransport;
  stash: ClaimStashPort;
}

const TOKEN: ClaimPhase = { kind: "token" };

function asClaimError(error: Error | null, fallback: string): ClaimError {
  if (error instanceof ClaimError) return error;
  return new ClaimError("unavailable", fallback, false);
}

/** Where a failure leaves the page; `presented` is what the bearer had done. */
function failed(
  deps: ClaimCeremonyDeps,
  thrown: Error | null,
  fallback: string,
  held: { token: string; presented: boolean },
): ClaimStep {
  const error = asClaimError(thrown, fallback);
  if (error.spent) {
    deps.stash.clear();
    return { phase: TOKEN, message: error.message };
  }
  const reason = error.kind === "signed_out" ? "identity" : "retry";
  return { phase: { kind: "paused", ...held, reason }, message: error.message };
}

/** The saved presentation, if this principal may read it back. */
function resumable(
  deps: ClaimCeremonyDeps,
  token: string,
  principalId: string,
): { claimId: string } | ClaimStep {
  const saved = deps.stash.read();
  // A presented claim without both is unresumable: the id says which claim
  // to read, and the principal says whose review this is.
  if (!saved?.claimId || !saved.principalId || saved.token !== token) {
    deps.stash.clear();
    return { phase: TOKEN, message: CLAIM_WORDS.unresumable };
  }
  if (saved.principalId !== principalId) {
    deps.stash.clear();
    return { phase: TOKEN, message: CLAIM_WORDS.otherAccount };
  }
  return { claimId: saved.claimId };
}

/** A claim the server answered with: open it, or say why it is closed. */
function settle(
  deps: ClaimCeremonyDeps,
  token: string,
  principalId: string,
  claim: ClaimReview,
): ClaimStep {
  if (!OPEN_CLAIM_STATES.has(claim.state)) {
    deps.stash.clear();
    return { phase: TOKEN, message: closedClaimWords(claim.state) };
  }
  deps.stash.write({ token, presented: true, claimId: claim.id, principalId });
  return { phase: { kind: "open", token, claim, principalId }, message: null };
}

/** Read or present, as the bearer's history says; a step when it cannot. */
async function fetchClaim(
  deps: ClaimCeremonyDeps,
  token: string,
  presented: boolean,
  principalId: string,
): Promise<ClaimReview | ClaimStep> {
  if (!presented) return presentClaim(deps.transport, token);
  const saved = resumable(deps, token, principalId);
  if ("phase" in saved) return saved;
  // Presenting twice is refused, and a stashed snapshot cannot say whether the
  // claim has since expired or been decided: read it back instead.
  return readClaim(deps.transport, saved.claimId, token);
}

/** One load, once the in-flight guard has let it through. */
async function loadOnce(
  deps: ClaimCeremonyDeps,
  held: { token: string; presented: boolean },
  mine: () => boolean,
): Promise<ClaimStep | null> {
  const { token, presented } = held;
  const principalId = deps.transport.principal();
  if (!principalId) {
    // Waiting for someone to accept as: the bearer must survive a sign-in.
    deps.stash.write({ token, presented });
    const message = presented
      ? CLAIM_WORDS.signInToFinish
      : CLAIM_WORDS.signInFirst;
    return { phase: { kind: "paused", ...held, reason: "identity" }, message };
  }
  try {
    const fetched = await fetchClaim(deps, token, presented, principalId);
    if (!mine()) return null;
    if ("phase" in fetched) return fetched;
    return settle(deps, token, principalId, fetched);
  } catch (error) {
    if (!mine()) return null;
    const thrown = error instanceof Error ? error : null;
    return failed(deps, thrown, CLAIM_WORDS.loadFallback, held);
  }
}

/** Accept an open claim for the principal it was presented to. */
async function completeOpen(
  deps: ClaimCeremonyDeps,
  open: ClaimOpen,
  userCode: string,
): Promise<ClaimStep> {
  // Holding the link is not consent, and spending the attempt fence to learn
  // the code was missing is the wrong way to find out.
  if (!userCode.trim()) return { phase: open, message: CLAIM_WORDS.needCode };
  // Read again, not trusted from when the claim was opened: ownership must
  // attach to the account that is accepting now.
  if (deps.transport.principal() !== open.principalId) {
    deps.stash.clear();
    return { phase: TOKEN, message: CLAIM_WORDS.identityChanged };
  }
  try {
    await completeClaim(
      deps.transport,
      open.claim.id,
      buildClaimCompletion(open.claim, userCode, open.token),
    );
  } catch (error) {
    const thrown = error instanceof Error ? error : null;
    const held = { token: open.token, presented: true };
    const step = failed(deps, thrown, CLAIM_WORDS.completeFallback, held);
    // A wrong code or a fault leaves the claim open to try again.
    return step.phase.kind === "paused" && step.phase.reason === "retry"
      ? { phase: open, message: step.message }
      : step;
  }
  // Spent for good; nothing left worth keeping in this tab.
  deps.stash.clear();
  return { phase: { kind: "done" }, message: null };
}

/** What an arrival asks for: a drop, a claim to load, a resume, or nothing. */
function startFrom(deps: ClaimCeremonyDeps, arrival: ClaimArrival): ClaimStart {
  if (arrival.kind === "drop") return arrival;
  if (arrival.kind === "claim") {
    return { kind: "load", token: arrival.token, presented: false };
  }
  if (arrival.kind === "leaked") {
    return { kind: "refused", message: CLAIM_WORDS.leaked };
  }
  // Reload, or back from signing in: the token is gone from the address.
  const saved = deps.stash.read();
  return saved
    ? { kind: "load", token: saved.token, presented: saved.presented }
    : { kind: "idle" };
}

export function createClaimCeremony(deps: ClaimCeremonyDeps) {
  /** The bearer being loaded, so the same one is never presented twice. */
  let inFlight: string | null = null;
  /** Which load may still speak: a superseded one must not undo the winner. */
  let run = 0;

  /**
   * Open the claim this bearer names: present it if unspent, read it back if
   * presented. `null` means the call was a repeat of one in flight, or was
   * superseded by a newer load, and has nothing to say.
   */
  async function load(
    token: string,
    presented: boolean,
  ): Promise<ClaimStep | null> {
    if (inFlight === token) return null;
    inFlight = token;
    const id = ++run;
    const mine = () => run === id;
    try {
      return await loadOnce(deps, { token, presented }, mine);
    } finally {
      // Only the newest load owns the guard; an older one clearing it would
      // let its own bearer be presented a second time.
      if (mine()) inFlight = null;
    }
  }

  /** A pasted token: ignored when blank, refused when not claim-shaped. */
  function submit(typed: string): Promise<ClaimStep | null> {
    const token = typed.trim();
    if (!token) return Promise.resolve(null);
    if (!isClaimToken(token)) {
      return Promise.resolve({ phase: TOKEN, message: CLAIM_WORDS.notAToken });
    }
    return load(token, false);
  }

  /**
   * The guest path: mint a provisional principal, then load again so the
   * claim presents to it. The token is spent only after an identity exists,
   * and linking an account later keeps the same principal id.
   */
  async function continueAsGuest(
    token: string,
    presented: boolean,
  ): Promise<ClaimStep | null> {
    try {
      await deps.transport.provisional();
    } catch {
      const phase: ClaimPhase = {
        kind: "paused",
        token,
        presented,
        reason: "identity",
      };
      return { phase, message: CLAIM_WORDS.guestFailed };
    }
    return load(token, presented);
  }

  return {
    /** What an arrival asks for: a drop, a claim to load, a resume, or nothing. */
    start: (arrival: ClaimArrival) => startFrom(deps, arrival),
    load,
    submit,
    continueAsGuest,
    /** Accept an open claim for the principal it was presented to. */
    complete: (open: ClaimOpen, userCode: string) =>
      completeOpen(deps, open, userCode),
    /** Forget the bearer, as sign-out does. */
    forget: () => deps.stash.clear(),
  };
}

export type ClaimCeremony = ReturnType<typeof createClaimCeremony>;

/** Pages' ceremony: its Identity transport and its tab-scoped stash. */
export const claimCeremony: ClaimCeremony = createClaimCeremony({
  transport: identityClaimTransport,
  stash: claimStash,
});
