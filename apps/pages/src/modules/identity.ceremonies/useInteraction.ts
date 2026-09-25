/**
 * The interaction approval as React state (ADR 0140 plan step 9). The steps
 * are `createInteractionApproval`'s (ceremony-kit, bound to Pages in
 * `app-core/lib/interactions.ts`); this hook only asks for them and keeps the
 * one it got back. It adds what a page needs around them:
 *
 *   - the ceremony loads once per reference;
 *   - a session appearing while it waits for a sign-in reads the request;
 *   - coming back into view re-reads it, which is what makes the frozen
 *     digest fire on a request rewritten while the screen was put down;
 *   - a refusal's words go to the notifications tray as well as the mark.
 */

import {
  type InteractionStep,
  clearInteractionNotice,
  interactionStepWords,
  reportInteraction,
} from "@opensesame/app-core/lib/interactions-route.js";
import {
  type InteractionApproval,
  interactionApproval,
} from "@opensesame/app-core/lib/interactions.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentitySession } from "../../bindings/identity.js";

export const interactionHookSeams = {
  approval: (ref: string): InteractionApproval => interactionApproval(ref),
};

const LOADING: InteractionStep = { phase: { kind: "loading" }, message: null };

export function useInteraction(ref: string) {
  const [ceremony] = useState(() => interactionHookSeams.approval(ref));
  const session = useIdentitySession();
  const [step, setStep] = useState<InteractionStep>(LOADING);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    async (work: () => Promise<InteractionStep | null>) => {
      setBusy(true);
      try {
        const next = await work();
        if (!next || !live.current) return;
        setStep(next);
        const words = interactionStepWords(next);
        if (words) reportInteraction(words);
        else clearInteractionNotice();
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: one load per ceremony
  useEffect(() => {
    void run(() => ceremony.load());
  }, [ceremony]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a session appearing is the only trigger
  useEffect(() => {
    if (session && ceremony.phase().kind === "signin") {
      void run(() => ceremony.read());
    }
  }, [session]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      if (ceremony.phase().kind === "review") void run(() => ceremony.read());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ceremony, run]);

  return {
    step,
    busy,
    load: () => void run(() => ceremony.load()),
    read: () => void run(() => ceremony.read()),
    approve: () => void run(() => ceremony.approve()),
    deny: () => void run(() => ceremony.deny()),
  };
}

export type InteractionView = ReturnType<typeof useInteraction>;
