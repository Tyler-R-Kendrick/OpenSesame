/**
 * Start a circle (ADR 0186 §10): a run of steps in one sheet. Name it and say
 * what it protects, hand the invitation to the people, set the rule over those
 * who answer, set the clocks, and make it; then hand each contact their
 * packet and take their receipts back.
 *
 * Only the step in hand is drawn. Steps already reached can be gone back to
 * until the circle is made; after that the sheet holds the packets, which
 * exist in memory only, until it is closed.
 */

import { useRef } from "react";
import { CeremonySheet } from "../../../components/CeremonySheet.js";
import { IconLayers } from "../../../components/Icons.js";
import { useVault } from "../../../lib/vault/hooks.js";
import type { Desk } from "../use-desk.js";
import { ClocksStep } from "./ClocksStep.js";
import { DealtStep } from "./DealtStep.js";
import { NameStep } from "./NameStep.js";
import { PeopleStep } from "./PeopleStep.js";
import { RuleStep } from "./RuleStep.js";
import { useLandOnChange } from "./circle-focus.js";
import { ruleSide } from "./circle-model.js";
import "./circles.css";
import {
  type NewCircle,
  RUN,
  type Step,
  reached,
  useNewCircle,
} from "./use-new-circle.js";

const LABEL = {
  name: "Circle",
  people: "People",
  rule: "Rule",
  clocks: "Clocks",
  dealt: "Packets",
} satisfies Record<Step, string>;

function Strip({ run }: { run: NewCircle }) {
  const shown = RUN.filter((step) => reached(step, run.furthest));
  if (run.step === "dealt" || shown.length < 2) return null;
  return (
    <ol className="tcc-steps" aria-label="Steps">
      {shown.map((step) => (
        <li key={step}>
          <button
            type="button"
            className="tcc-choice"
            aria-pressed={step === run.step}
            onClick={() => run.go(step)}
          >
            {LABEL[step]}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Current({ desk, run }: { desk: Desk; run: NewCircle }) {
  const { begun } = run;
  const vault = useVault();
  if (run.step === "name" || !begun) {
    return <NameStep desk={desk} folders={vault.folders} onBegun={run.begin} />;
  }
  const circleId = begun.draft.circleId;
  switch (run.step) {
    case "people":
      return (
        <PeopleStep
          desk={desk}
          circleId={circleId}
          invite={begun.invite}
          facts={[
            { key: "Circle", value: begun.draft.label },
            { key: "Protects", value: begun.draft.collection },
          ]}
          people={run.guardians}
          onPeople={run.setGuardians}
          next={{ label: "Set the rule", onNext: () => run.go("rule") }}
        />
      );
    case "rule":
      return (
        <RuleStep
          people={run.people}
          rule={run.rule}
          onRule={run.setRule}
          issues={run.ruleIssues}
          review={ruleSide(run.review)}
          onNext={() => run.go("clocks")}
        />
      );
    case "clocks":
      return (
        <ClocksStep
          clocks={run.clocks}
          onClocks={run.setClocks}
          recovers={begun.draft.recovers}
          issues={run.clockIssues}
          review={run.review}
          busy={run.busy}
          failure={run.failure.message}
          onMake={() => void run.make()}
        />
      );
    case "dealt":
      return run.made ? (
        <DealtStep
          desk={desk}
          circleId={circleId}
          circleName={begun.draft.label}
          dealt={run.made.dealt}
          custody={run.made.custody}
          carried={run.made.carried}
        />
      ) : null;
  }
}

export function NewCircleSheet({
  desk,
  onClose,
}: {
  desk: Desk;
  onClose: () => void;
}) {
  const vault = useVault();
  const run = useNewCircle(desk, vault, onClose);
  const region = useRef<HTMLDivElement>(null);
  useLandOnChange(run.step, region);
  return (
    <CeremonySheet
      title="Start a circle"
      mark={<IconLayers size={20} />}
      onClose={run.leave}
    >
      {run.ready ? (
        <>
          <Strip run={run} />
          <div ref={region}>
            <Current desk={desk} run={run} />
          </div>
        </>
      ) : null}
    </CeremonySheet>
  );
}
