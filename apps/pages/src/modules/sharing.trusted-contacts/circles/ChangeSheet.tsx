/**
 * Change a circle (ADR 0187 §9): choose who leaves, take in the people invited
 * since, set the rule and the clocks over who is left, and make the next
 * epoch. Everyone who stays or joins is dealt a new share, and each who left
 * is handed a notice. The recovery file made before no longer opens the
 * circle; the sheet says so with a mark and holds the new one.
 */

import type { OwnedRecord } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { ruleText } from "@opensesame/app-core/lib/quorum/records.js";
import { useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconEdit, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import type { Desk } from "../use-desk.js";
import { ClocksFields } from "./ClocksFields.js";
import { DealtStep } from "./DealtStep.js";
import { RuleEditor } from "./RuleEditor.js";
import { useLandOnChange, useLandOnIdAfter } from "./circle-focus.js";
import "./circles.css";
import { type ChangeCircle, useChangeCircle } from "./use-change-circle.js";

function Roster({ change }: { change: ChangeCircle }) {
  const { before, leaving, newcomers } = change;
  return (
    <ul className="tcc-people" aria-label="Contacts">
      {before.guardians.map((person) => {
        const out = leaving.has(person.id);
        return (
          <li key={person.id} className="tcc-person">
            <span className="tcc-person__name">{person.name}</span>
            {out ? (
              <StatusMark
                tone="warn"
                label={`${person.name} leaves at this epoch`}
              />
            ) : null}
            <IconKey
              small
              armed={out}
              aria-pressed={out}
              label={`Remove ${person.name}`}
              onClick={() => change.toggle(person.id)}
            >
              <IconX size={16} />
            </IconKey>
          </li>
        );
      })}
      {newcomers.map((person) => (
        <li key={person.id} className="tcc-person">
          <span className="tcc-person__name">{person.name}</span>
          <StatusMark
            tone="idle"
            label={`${person.name} joins at this epoch`}
          />
          <IconKey
            small
            label={`Remove ${person.name}`}
            onClick={() => void change.dropNewcomer(person.id)}
          >
            <IconX size={16} />
          </IconKey>
        </li>
      ))}
    </ul>
  );
}

function Form({ change }: { change: ChangeCircle }) {
  const { before, people } = change;
  const recovers = before.operations.includes("recover-collection");
  const empty = people.length === 0;
  const blocked =
    empty ||
    change.ruleIssues.length > 0 ||
    change.clockIssues.length > 0 ||
    change.review.issues.length > 0;
  return (
    <form
      aria-label="Change the circle"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) void change.make();
      }}
    >
      <CeremonyShell
        name={ruleText(before)}
        facts={[
          { key: "Epoch", value: String(before.epoch) },
          { key: "Protects", value: before.collection },
        ]}
        primary={{
          label: "Make the new epoch",
          submit: true,
          busy: change.busy,
          disabled: blocked,
          onClick: () => undefined,
        }}
      >
        <Roster change={change} />
        {empty ? (
          <StatusMark tone="err" label="A circle needs at least one contact." />
        ) : null}
        {change.removal.message ? (
          <StatusMark tone="err" label={change.removal.message} />
        ) : null}
        {empty ? null : (
          <RuleEditor
            people={people}
            rule={change.rule}
            onRule={change.setRule}
            issues={change.ruleIssues}
            review={change.review}
          />
        )}
        <ClocksFields
          clocks={change.clocks}
          onClocks={change.setClocks}
          recovers={recovers}
          issues={change.clockIssues}
          review={empty ? { issues: [], warnings: [] } : change.review}
        />
        {change.failure.message ? (
          <StatusMark tone="err" label={change.failure.message} />
        ) : null}
      </CeremonyShell>
    </form>
  );
}

function Body({
  desk,
  record,
  onClose,
}: {
  desk: Desk;
  record: OwnedRecord;
  onClose: () => void;
}) {
  const vault = useVault();
  const change = useChangeCircle(desk, record, vault);
  const region = useRef<HTMLDivElement>(null);
  useLandOnChange(change.changed ? "dealt" : "form", region);
  // A newcomer let go takes its key out of the page: the keyboard goes on to the rule.
  useLandOnIdAfter(String(change.newcomers.length), "tcc-needed");
  return (
    <CeremonySheet
      title="Change the circle"
      mark={<IconEdit size={20} />}
      onClose={onClose}
    >
      <div ref={region}>
        {!change.ready ? null : change.changed ? (
          <DealtStep
            desk={desk}
            circleId={change.before.circleId}
            circleName={change.before.label}
            dealt={change.changed.dealt}
            custody={change.changed.custody}
            carried={change.changed.carried}
            replacesFile={change.changed.dealt.bundleFile !== null}
          />
        ) : (
          <Form change={change} />
        )}
      </div>
    </CeremonySheet>
  );
}

export function ChangeSheet({
  desk,
  circleId,
  onClose,
}: {
  desk: Desk;
  circleId: string;
  onClose: () => void;
}) {
  const record = desk.owned.find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  return record ? <Body desk={desk} record={record} onClose={onClose} /> : null;
}
