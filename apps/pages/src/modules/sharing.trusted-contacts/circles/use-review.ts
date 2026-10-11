/**
 * A rule and a set of clocks, read as the desk will read them: what is typed
 * turned into the inputs of a circle, and the desk's verdict on those inputs.
 * Shared by the run that makes a circle and the sheet that changes one, which
 * differ only in what a draft is judged against.
 */

import type {
  Preview,
  RuleInput,
  TimingInput,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useMemo } from "react";
import {
  type ClocksDraft,
  type ClocksParse,
  type Issue,
  NOTHING_TO_REVIEW,
  type Person,
  type Review,
  type RuleDraft,
  type RuleParse,
  defaultRule,
  parseClocks,
  reconcileRule,
  review,
  ruleInput,
} from "./circle-model.js";

const NO_ISSUES: readonly Issue[] = [];

/** The desk's verdict on a draft, or `null` while there is nothing yet to judge. */
export type Judge = (rule: RuleInput, timing: TimingInput) => Preview;

export type Reviewed = Readonly<{
  /** The rule as it stands for these people. */
  rule: RuleDraft;
  ruleParse: RuleParse;
  clockParse: ClocksParse;
  ruleIssues: readonly Issue[];
  clockIssues: readonly Issue[];
  review: Review;
}>;

export function useReview(
  people: readonly Person[],
  typedRule: RuleDraft | null,
  clocks: ClocksDraft,
  judge: Judge | null,
  fresh: (people: readonly Person[]) => RuleDraft = defaultRule,
): Reviewed {
  const rule = useMemo(
    () => reconcileRule(typedRule, people, fresh),
    [typedRule, people, fresh],
  );
  const ruleParse = useMemo(() => ruleInput(rule, people), [rule, people]);
  const clockParse = useMemo(() => parseClocks(clocks), [clocks]);
  const verdict = useMemo(() => {
    if (judge === null || !ruleParse.ok || !clockParse.ok) {
      return NOTHING_TO_REVIEW;
    }
    return review(judge(ruleParse.rule, clockParse.timing));
  }, [judge, ruleParse, clockParse]);
  return {
    rule,
    ruleParse,
    clockParse,
    ruleIssues: ruleParse.ok ? NO_ISSUES : ruleParse.issues,
    clockIssues: clockParse.ok ? NO_ISSUES : clockParse.issues,
    review: verdict,
  };
}
