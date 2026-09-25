/**
 * The claim ceremony as React state (ADR 0140 plan step 8). The steps are
 * `createClaimCeremony`'s; this hook only asks for them and keeps the one it
 * got back. It adds three things a page needs:
 *
 *   - an arrival starts the ceremony (`claimStartFor`), and a new arrival —
 *     a pasted link — starts it again;
 *   - a session appearing while the claim waits for one picks it up, so
 *     connecting (or signing in and coming back) resumes without a press;
 *   - a failure's words go to the notifications tray as well as the mark,
 *     and a spent or finished claim is forgotten from the route's memory.
 */

import { takeClaimArrival } from "@opensesame/app-core/lib/claims/arrival.js";
import {
  CLAIM_WORDS,
  type ClaimCeremony,
  type ClaimOpen,
  type ClaimStep,
  claimCeremony,
} from "@opensesame/app-core/lib/claims/ceremony.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import {
  claimStartFor,
  clearClaimNotice,
  reportClaim,
} from "@opensesame/app-core/lib/claims/route-model.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentitySession } from "../../bindings/identity.js";

export type ClaimTone = "err" | "warn";

export type ClaimView = Readonly<{
  step: ClaimStep;
  /** How the step's words read: a failure, or a wait for someone to sign in. */
  tone: ClaimTone | null;
  busy: boolean;
  /** Say something about the entry itself (a paste that is not a claim). */
  say: (words: string) => void;
  retry: () => void;
  guest: () => void;
  complete: (open: ClaimOpen, userCode: string) => void;
}>;

const IDLE: ClaimStep = { phase: { kind: "token" }, message: null };

/** A wait for a session is not a failure; everything else with words is. */
export function toneOf(step: ClaimStep): ClaimTone | null {
  if (!step.message) return null;
  const { phase } = step;
  const waiting =
    phase.kind === "paused" &&
    phase.reason === "identity" &&
    step.message !== CLAIM_WORDS.guestFailed;
  return waiting ? "warn" : "err";
}

export const claimHookSeams = {
  ceremony: (): ClaimCeremony => claimCeremony,
};

export function useClaimCeremony(arrival: ClaimArrival): ClaimView {
  const ceremony = claimHookSeams.ceremony();
  const session = useIdentitySession();
  const [step, setStep] = useState<ClaimStep>(IDLE);
  // An arrival that loads starts busy, so the paste field never flashes.
  const [busy, setBusy] = useState(
    () => claimStartFor(ceremony, arrival).kind === "load",
  );
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const apply = useCallback((next: ClaimStep | null) => {
    if (!next || !live.current) return;
    setStep(next);
    if (toneOf(next) === "err" && next.message) reportClaim(next.message);
    else clearClaimNotice();
    // Spent, refused for good, or accepted: nothing left for the route to hold.
    if (next.phase.kind === "token" || next.phase.kind === "done") {
      takeClaimArrival();
    }
  }, []);

  const run = useCallback(
    async (work: () => Promise<ClaimStep | null>) => {
      setBusy(true);
      try {
        apply(await work());
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [apply],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: an arrival starts the ceremony once
  useEffect(() => {
    const start = claimStartFor(ceremony, arrival);
    if (start.kind === "load") {
      void run(() => ceremony.load(start.token, start.presented));
    } else if (start.kind === "refused") {
      apply({ phase: IDLE.phase, message: start.message });
    }
  }, [arrival]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a session appearing is the only trigger
  useEffect(() => {
    const { phase } = step;
    if (!session || phase.kind !== "paused" || phase.reason !== "identity") {
      return;
    }
    void run(() => ceremony.load(phase.token, phase.presented));
  }, [session]);

  const retry = useCallback(() => {
    const { phase } = step;
    if (phase.kind !== "paused") return;
    void run(() => ceremony.load(phase.token, phase.presented));
  }, [ceremony, run, step]);

  const guest = useCallback(() => {
    const { phase } = step;
    if (phase.kind !== "paused") return;
    void run(() => ceremony.continueAsGuest(phase.token, phase.presented));
  }, [ceremony, run, step]);

  const complete = useCallback(
    (open: ClaimOpen, userCode: string) =>
      void run(() => ceremony.complete(open, userCode)),
    [ceremony, run],
  );

  const say = useCallback(
    (words: string) => apply({ phase: IDLE.phase, message: words }),
    [apply],
  );

  return { step, tone: toneOf(step), busy, say, retry, guest, complete };
}
