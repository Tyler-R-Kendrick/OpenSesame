import {
  type EvaluationDecision,
  type EvaluationInput,
  type Evaluator,
  evaluateDecision,
} from "./evaluate.js";

export type SavedPolicyTest = {
  id: string;
  name: string;
  input: EvaluationInput;
  expect: EvaluationDecision;
};

export type PolicyTestRun = {
  id: string;
  name: string;
  expect: EvaluationDecision;
  actual: EvaluationDecision;
  passed: boolean;
};

export function runSavedPolicyTests(
  tests: readonly SavedPolicyTest[],
  evaluator: Evaluator,
): PolicyTestRun[] {
  return tests.map((test) => {
    const result = evaluateDecision(evaluator, test.input, "simulate");
    return {
      id: test.id,
      name: test.name,
      expect: test.expect,
      actual: result.decision,
      passed: result.decision === test.expect,
    };
  });
}

export function publicationBlocked(runs: readonly PolicyTestRun[]): boolean {
  return runs.some((run) => !run.passed);
}
