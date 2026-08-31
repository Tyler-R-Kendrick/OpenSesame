import type { ReactNode, Ref } from "react";
import {
  OUTCOME_IS_REFUSAL,
  OUTCOME_MARK,
  OUTCOME_TEXT,
  type Outcome,
} from "./approval.js";

/**
 * The panel that ends the screen.
 *
 * One component for every ending — approved, denied, withdrawn, expired,
 * already used, not found, and a link that should never have existed — because
 * each of them has the same three obligations and they are all easy to lose
 * one at a time: the word (never colour alone), the mark beside it, and an
 * announcement that interrupts when the news is a refusal.
 *
 * It renders no action. A terminal state is terminal; offering a control here
 * would be offering a way to answer a question that is already answered.
 */
export interface OutcomePanelProps {
  outcome: Outcome;
  /** Focused when the panel mounts, so the answer is where the caret is. */
  headingRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
}

export function OutcomePanel({
  outcome,
  headingRef,
  children,
}: OutcomePanelProps) {
  return (
    <section
      className="approve approve--done"
      data-outcome={outcome}
      role={OUTCOME_IS_REFUSAL[outcome] ? "alert" : "status"}
    >
      <h1 className="outcome" ref={headingRef} tabIndex={-1}>
        <span className="outcome__mark" aria-hidden="true">
          {OUTCOME_MARK[outcome]}
        </span>
        {OUTCOME_TEXT[outcome]}
      </h1>
      {children}
    </section>
  );
}
