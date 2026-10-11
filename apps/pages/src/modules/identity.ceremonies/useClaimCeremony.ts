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

function applyClaimStep(
  live: { current: boolean },
  setStep: (step: ClaimStep) => void,
  next: ClaimStep | null,
) {
  if (!next || !live.current) return;
  setStep(next);
  if (toneOf(next) === "err" && next.message) reportClaim(next.message);
  if (next.phase.kind === "token" || next.phase.kind === "done") {
    takeClaimArrival();
  }
}

async function runClaimStep(
  generation: number,
  arrivalGeneration: { current: number },
  live: { current: boolean },
  setBusy: (busy: boolean) => void,
  apply: (next: ClaimStep | null) => void,
  work: () => Promise<ClaimStep | null>,
) {
  setBusy(true);
  try {
    const next = await work();
    if (generation !== arrivalGeneration.current) return;
    apply(next);
  } finally {
    if (generation === arrivalGeneration.current && live.current) {
      setBusy(false);
    }
  }
}

function startFromArrival(
  ceremony: ClaimCeremony,
  arrivalGeneration: { current: number },
  live: { current: boolean },
  setStep: (step: ClaimStep) => void,
  setBusy: (busy: boolean) => void,
  apply: (next: ClaimStep | null) => void,
  arrival: ClaimArrival,
) {
  const start = claimStartFor(ceremony, arrival);
  if (start.kind === "load") {
    void runClaimStep(
      arrivalGeneration.current,
      arrivalGeneration,
      live,
      setBusy,
      apply,
      () => ceremony.load(start.token, start.presented),
    );
    return;
  }
  if (start.kind === "refused") {
    apply({ phase: IDLE.phase, message: start.message });
    return;
  }
  if (start.kind === "idle") {
    setStep(IDLE);
    setBusy(false);
  }
}

export const claimHookSeams = {
  ceremony: (): ClaimCeremony => claimCeremony,
};

export function useClaimCeremony(arrival: ClaimArrival): ClaimView {
  const ceremony = claimHookSeams.ceremony();
  const session = useIdentitySession();
  const [step, setStep] = useState<ClaimStep>(IDLE);
  const [busy, setBusy] = useState(
    () => claimStartFor(ceremony, arrival).kind === "load",
  );
  const live = useRef(true);
  const arrivalGeneration = useRef(0);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const apply = useCallback(
    (next: ClaimStep | null) => applyClaimStep(live, setStep, next),
    [],
  );

  const run = useCallback(
    (work: () => Promise<ClaimStep | null>) =>
      runClaimStep(
        arrivalGeneration.current,
        arrivalGeneration,
        live,
        setBusy,
        apply,
        work,
      ),
    [apply],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: an arrival starts the ceremony once
  useEffect(() => {
    arrivalGeneration.current += 1;
    startFromArrival(
      ceremony,
      arrivalGeneration,
      live,
      setStep,
      setBusy,
      apply,
      arrival,
    );
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
