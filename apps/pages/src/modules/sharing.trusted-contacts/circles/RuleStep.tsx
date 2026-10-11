/**
 * Step three of a new circle: the rule over the people who answered. Moving
 * on is open only while the desk finds the rule sound.
 */

import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconArrowRight } from "../../../components/Icons.js";
import { RuleEditor } from "./RuleEditor.js";
import type { Issue, Person, Review, RuleDraft } from "./circle-model.js";

export function RuleStep({
  people,
  rule,
  onRule,
  issues,
  review,
  onNext,
}: {
  people: readonly Person[];
  rule: RuleDraft;
  onRule: (next: RuleDraft) => void;
  issues: readonly Issue[];
  review: Review;
  onNext: () => void;
}) {
  const blocked = issues.length > 0 || review.issues.length > 0;
  return (
    <form
      aria-label="Set the rule"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onNext();
      }}
    >
      <CeremonyShell
        name="Rule"
        primary={{
          label: "Set the clocks",
          icon: <IconArrowRight size={18} />,
          submit: true,
          disabled: blocked,
          onClick: () => undefined,
        }}
      >
        <RuleEditor
          people={people}
          rule={rule}
          onRule={onRule}
          issues={issues}
          review={review}
        />
      </CeremonyShell>
    </form>
  );
}
