/**
 * The authorization-request review as React state (ADR 0140 plan step 9).
 * The steps are `createApprovalReview`'s (ceremony-kit, bound to Pages in
 * `app-core/lib/approvals.ts`): this hook asks for them, keeps the one it
 * got back, and sends a refusal's words to the tray as well as the mark.
 * What a decision carries in (the confirmation, the comparison code) is
 * handed to the model for that call only and never kept here.
 */

import {
  type ApprovalReview,
  type ApprovalStep,
  type DecisionInput,
  approvalStepWords,
  clearApprovalNotice,
  reportApproval,
} from "@opensesame/app-core/lib/approvals-route.js";
import { approvalReview } from "@opensesame/app-core/lib/approvals.js";
import { useCallback, useEffect, useRef, useState } from "react";

export const approvalHookSeams = {
  review: (ref: string): ApprovalReview => approvalReview(ref),
};

const LOADING: ApprovalStep = {
  phase: { kind: "loading" },
  message: null,
  alarm: false,
};

export function useApprovalReview(ref: string) {
  const [review] = useState(() => approvalHookSeams.review(ref));
  const [step, setStep] = useState<ApprovalStep>(LOADING);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<ApprovalStep | null>) => {
    setBusy(true);
    try {
      const next = await work();
      if (!next || !live.current) return;
      setStep(next);
      const words = approvalStepWords(next);
      if (words) reportApproval(words);
      else clearApprovalNotice();
    } finally {
      if (live.current) setBusy(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one load per review
  useEffect(() => {
    void run(() => review.load());
  }, [review]);

  return {
    step,
    busy,
    load: () => void run(() => review.load()),
    approve: (input: DecisionInput) => void run(() => review.approve(input)),
    deny: (input: DecisionInput) => void run(() => review.deny(input)),
    report: () => void run(() => review.report()),
  };
}

export type ApprovalReviewView = ReturnType<typeof useApprovalReview>;
