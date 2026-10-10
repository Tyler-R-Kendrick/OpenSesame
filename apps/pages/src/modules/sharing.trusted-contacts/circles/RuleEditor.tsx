/**
 * The rule of a circle as a form: how many of the contacts it takes, or,
 * with two groups, how many of each and how many groups. Shared by the step
 * that makes a circle and the sheet that changes one.
 *
 * The desk judges the draft as it is edited (`previewCircle`); what it says is
 * a mark on the field it is about, and what a careful owner would still want
 * to hear is a warning beside the rule. None of it is a failure, so none of
 * it reaches the tray.
 */

import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { Choices, FieldMark } from "./Choices.js";
import {
  type Issue,
  type Person,
  type Review,
  type RuleDraft,
  type Side,
  issueOn,
  withOneGroup,
  withSecondGroup,
} from "./circle-model.js";

const SIDES: readonly { value: Side; label: string }[] = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
];

const GROUP_COUNTS = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
] as const;

const GROUPING = [
  { value: "one", label: "One group" },
  { value: "two", label: "Add a second group" },
] as const;

export function RuleEditor({
  people,
  rule,
  onRule,
  issues,
  review,
}: {
  people: readonly Person[];
  rule: RuleDraft;
  onRule: (next: RuleDraft) => void;
  /** What is not a number yet. */
  issues: readonly Issue[];
  /** What the desk made of the draft. */
  review: Review;
}) {
  const groupsMessage =
    issueOn("groups", issues, review.issues) ??
    issueOn("members", issues, review.issues);
  const stepMessage = issueOn("step", issues, review.issues);
  return (
    <>
      <FieldShell
        id="tcc-needed"
        label={rule.second ? "Needed in group A" : "Needed"}
        inputMode="numeric"
        autoComplete="off"
        value={rule.needed.A}
        onValueChange={(A) =>
          onRule({ ...rule, needed: { ...rule.needed, A } })
        }
        status={
          <FieldMark message={issueOn("needed", issues, review.issues)} />
        }
      />
      <Choices
        label="Groups"
        options={GROUPING}
        value={rule.second ? "two" : "one"}
        onChange={(next) =>
          onRule(
            next === "two"
              ? withSecondGroup(rule, people)
              : withOneGroup(rule, people),
          )
        }
        message={rule.second ? groupsMessage : null}
      />
      {rule.second ? (
        <>
          <FieldShell
            id="tcc-needed-b"
            label="Needed in group B"
            inputMode="numeric"
            autoComplete="off"
            value={rule.needed.B}
            onValueChange={(B) =>
              onRule({ ...rule, needed: { ...rule.needed, B } })
            }
            status={
              <FieldMark message={issueOn("needed-b", issues, review.issues)} />
            }
          />
          <Choices
            label="Groups needed"
            options={GROUP_COUNTS}
            value={rule.groupsNeeded}
            onChange={(groupsNeeded) => onRule({ ...rule, groupsNeeded })}
          />
          {people.map((person) => (
            <Choices
              key={person.id}
              label={`Group for ${person.name}`}
              options={SIDES}
              value={rule.sides[person.id] ?? "A"}
              onChange={(side) =>
                onRule({ ...rule, sides: { ...rule.sides, [person.id]: side } })
              }
            />
          ))}
        </>
      ) : null}
      {review.warnings.length > 0 || stepMessage ? (
        <span className="tc-row__marks">
          {review.warnings.map((warning) => (
            <StatusMark
              key={`${warning.code}:${warning.message}`}
              tone="warn"
              label={warning.message}
            />
          ))}
          {stepMessage ? <StatusMark tone="err" label={stepMessage} /> : null}
        </span>
      ) : null}
    </>
  );
}
