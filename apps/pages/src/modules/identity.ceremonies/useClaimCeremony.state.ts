import { takeClaimArrival } from "@opensesame/app-core/lib/claims/arrival.js";
import type {
  ClaimCeremony,
  ClaimOpen,
  ClaimStep,
} from "@opensesame/app-core/lib/claims/ceremony.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import {
  claimStartFor,
  reportClaim,
} from "@opensesame/app-core/lib/claims/route-model.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentitySession } from "../../bindings/identity.js";
import { toneOf } from "./useClaimCeremony.tone.js";

const IDLE: ClaimStep = { phase: { kind: "token" }, message: null };

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

type ClaimCeremonyHost = {
  ceremony: ClaimCeremony;
  arrivalGeneration: { current: number };
  live: { current: boolean };
  setStep: (step: ClaimStep) => void;
  setBusy: (busy: boolean) => void;
  apply: (next: ClaimStep | null) => void;
};

function startFromArrival(host: ClaimCeremonyHost, arrival: ClaimArrival) {
  const start = claimStartFor(host.ceremony, arrival);
  if (start.kind === "load") {
    void runClaimStep(
      host.arrivalGeneration.current,
      host.arrivalGeneration,
      host.live,
      host.setBusy,
      host.apply,
      () => host.ceremony.load(start.token, start.presented),
    );
    return;
  }
  if (start.kind === "refused") {
    host.apply({ phase: IDLE.phase, message: start.message });
    return;
  }
  if (start.kind === "idle") {
    host.setStep(IDLE);
    host.setBusy(false);
  }
}

export function useClaimCeremonyState(
  ceremony: ClaimCeremony,
  arrival: ClaimArrival,
) {
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

  const host = {
    ceremony,
    arrivalGeneration,
    live,
    setStep,
    setBusy,
    apply,
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: an arrival starts the ceremony once
  useEffect(() => {
    arrivalGeneration.current += 1;
    startFromArrival(host, arrival);
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

  return { step, busy, say, retry, guest, complete };
}
