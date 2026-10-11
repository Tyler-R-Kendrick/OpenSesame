/**
 * The clocks of a circle as a form: how long contacts have to approve, how
 * long a released share waits before it can be used, how long a request
 * lives, and whether a key must prove a PIN or biometric as well as a touch.
 * Shared by the step that makes a circle and the sheet that changes one.
 */

import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { FieldMark, SwitchRow } from "./Choices.js";
import {
  type ClocksDraft,
  type Issue,
  type Review,
  issueOn,
} from "./circle-model.js";

export function ClocksFields({
  clocks,
  onClocks,
  recovers,
  issues,
  review,
}: {
  clocks: ClocksDraft;
  onClocks: (next: ClocksDraft) => void;
  /** A recovering circle releases shares; an approvals-only one acts. */
  recovers: boolean;
  /** What is not a number or is out of range. */
  issues: readonly Issue[];
  /** What the desk made of the draft. */
  review: Review;
}) {
  return (
    <>
      <FieldShell
        id="tcc-minutes"
        label="Minutes to approve"
        inputMode="numeric"
        autoComplete="off"
        value={clocks.minutes}
        onValueChange={(minutes) => onClocks({ ...clocks, minutes })}
        status={
          <FieldMark message={issueOn("minutes", issues, review.issues)} />
        }
      />
      <FieldShell
        id="tcc-hours"
        label={
          recovers
            ? "Hours before a share is released"
            : "Hours before it takes effect"
        }
        inputMode="numeric"
        autoComplete="off"
        value={clocks.hours}
        onValueChange={(hours) => onClocks({ ...clocks, hours })}
        status={<FieldMark message={issueOn("hours", issues, review.issues)} />}
      />
      <FieldShell
        id="tcc-days"
        label="Days a request lasts"
        inputMode="numeric"
        autoComplete="off"
        value={clocks.days}
        onValueChange={(days) => onClocks({ ...clocks, days })}
        status={<FieldMark message={issueOn("days", issues, review.issues)} />}
      />
      <SwitchRow
        id="tcc-verify"
        label="Require a PIN or biometric"
        on={clocks.verify}
        onChange={(verify) => onClocks({ ...clocks, verify })}
      />
      {review.warnings.length > 0 || issueOn("step", review.issues) ? (
        <span className="tc-row__marks">
          {review.warnings.map((warning) => (
            <StatusMark
              key={`${warning.code}:${warning.message}`}
              tone="warn"
              label={warning.message}
            />
          ))}
          {issueOn("step", review.issues) ? (
            <StatusMark
              tone="err"
              label={issueOn("step", review.issues) ?? ""}
            />
          ) : null}
        </span>
      ) : null}
    </>
  );
}
