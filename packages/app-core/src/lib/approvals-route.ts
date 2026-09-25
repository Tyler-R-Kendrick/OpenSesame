/**
 * What the `/approve/:ref` route shows for an arrival (ADR 0140 plan step
 * 9), with no React: which request opens, which link was refused before
 * anything was called, how a review's ending reads, and the one tray notice
 * a refusal is reported through. The words are ceremony-kit's
 * (`approval-words.ts`, `approval-copy.ts`, `OUTCOME_TEXT`).
 */

import {
  APPROVAL_LABELS,
  APPROVAL_WORDS,
  type ApprovalArrival,
  type ApprovalEnding,
  type ApprovalPhase,
  type ApprovalReview,
  type ApprovalStep,
  type DecisionInput,
  OUTCOME_TEXT,
  approvalRefAt,
  approvalWords,
  arrivedViaSentence,
  describeDetail,
  requirementSentences,
  riskSentence,
} from "@opensesame/ceremony-kit";
import { dismissNotice, setStatusNotice } from "./notices.js";

export { APPROVAL_LABELS };
export type {
  ApprovalEnding,
  ApprovalPhase,
  ApprovalReview,
  ApprovalStep,
  DecisionInput,
};

/** What the route says with no session to read a request with. */
export const APPROVAL_SIGN_IN = approvalWords("signin").words;

/** The title a link refused before anything was called ends under. */
export const APPROVAL_LINK_ENDED = APPROVAL_WORDS.endedOnLoad;

type Review = Extract<ApprovalPhase, { kind: "review" }>;

/** A review's facts as the rows a screen draws, all in ceremony-kit's words. */
export function reviewFacts({ request, requirement }: Review): {
  asker: string;
  grants: string[];
  needs: string[];
} {
  const kind = request.requesterKind ? ` (${request.requesterKind})` : "";
  return {
    asker: request.requesterRef
      ? `${request.requesterRef}${kind}`
      : APPROVAL_LABELS.unnamed,
    grants: request.authorizationDetails.map(describeDetail),
    needs: [
      riskSentence(requirement.riskClass),
      ...requirementSentences(requirement.required),
      ...(requirement.arrivedVia
        ? [arrivedViaSentence(requirement.arrivedVia)]
        : []),
    ],
  };
}

/** The tray notice a review reports through, one at a time. */
export const APPROVAL_NOTICE = "identity.approval";

export type ApprovalEntry =
  | { kind: "review"; ref: string }
  /** The link was refused before anything was called. */
  | { kind: "ended"; words: string };

/**
 * Where `pathname` starts. A request opens only when the route's own path
 * names exactly it, read by ceremony-kit's bounded parser; a reference held
 * from an earlier address never answers for another path.
 */
export function approvalEntry(
  arrival: ApprovalArrival,
  pathname: string,
): ApprovalEntry {
  if (arrival.kind === "request" && approvalRefAt(pathname) === arrival.ref) {
    return { kind: "review", ref: arrival.ref };
  }
  return {
    kind: "ended",
    words: approvalWords(arrival.kind === "refused" ? "rejected" : "not_found")
      .words,
  };
}

/** A review's ending as a title and a mark. */
export function endingMark(ending: ApprovalEnding): {
  title: string;
  tone: "ok" | "warn" | "err";
  words: string;
} {
  if (ending.kind === "approved" || ending.kind === "denied") {
    return {
      title: OUTCOME_TEXT[ending.kind],
      tone: "ok",
      words: ending.words,
    };
  }
  const tone = ending.kind === "reported" ? "warn" : "err";
  return { title: ending.title, tone, words: ending.words };
}

/**
 * What a step says to the tray: its message, or the words of a review that
 * ended without the person deciding it (withdrawn, expired, changed).
 */
export function approvalStepWords(step: ApprovalStep): string | null {
  if (step.message) return step.message;
  const { phase } = step;
  return phase.kind === "done" && phase.ending.kind === "ended"
    ? phase.ending.words
    : null;
}

const TITLE = "Request";

/** Say why a review stopped, in the tray; the same words mark the page. */
export function reportApproval(words: string): void {
  setStatusNotice({
    id: APPROVAL_NOTICE,
    tone: "err",
    title: TITLE,
    body: words,
  });
}

export function clearApprovalNotice(): void {
  dismissNotice(APPROVAL_NOTICE);
}
