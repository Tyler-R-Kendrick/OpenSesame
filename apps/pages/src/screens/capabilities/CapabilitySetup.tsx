/**
 * The capabilities tab of setup — entry roads, purpose, cards, review, apply.
 *
 * Three roads in, each a choice object: the minimal configuration, a
 * customized installation, or joining an instance whose operator already
 * decided. Purpose cards come from `PRESETS`; capability cards from the
 * catalog; the review from the store. Nothing on this screen imports an
 * implementation, opens a connection or asks the browser for anything until
 * Apply has committed (CONSENT-01). The tools row holds Save on this device,
 * Export instance configuration and — only when a publication capability is
 * approved — Publish deployment configuration.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import { useEffect, useRef } from "react";
import {
  IconAuthority,
  IconCheck,
  IconDownload,
  IconLogin,
  IconSettings,
  IconUpload,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { exportInstanceConfiguration } from "../../lib/configuration/capabilities-export.js";
import {
  PRESETS,
  PUBLICATION_CAPABILITIES,
} from "../../lib/configuration/capabilities-ports.js";
import { landFocus } from "../../lib/focus.js";
import { CapabilityCard } from "./CapabilityCard.js";
import { CapabilityReview } from "./CapabilityReview.js";
import { InstallationRequirements } from "./InstallationRequirements.js";
import { PurposeCards } from "./PurposeCards.js";
import { deploymentConfigurationYaml } from "./deployment-config.js";
import { saveTextFile } from "./download.js";
import {
  type CapabilitySetupModel,
  useCapabilitySetup,
} from "./useCapabilitySetup.js";
import "./capabilities.css";

const ROADS: ReadonlyArray<{
  id: "minimal" | "customize" | "join";
  name: string;
  kind: string;
  Icon: typeof IconCheck;
}> = [
  {
    id: "minimal",
    name: "Use the minimal configuration",
    kind: "core only, nothing optional",
    Icon: IconCheck,
  },
  {
    id: "customize",
    name: "Customize this installation",
    kind: "choose a purpose, then each capability",
    Icon: IconSettings,
  },
  {
    id: "join",
    name: "Join an existing instance",
    kind: "accept what its operator requires",
    Icon: IconLogin,
  },
];

function Roads({
  model,
  firstRoad,
}: {
  model: CapabilitySetupModel;
  firstRoad: React.RefObject<HTMLButtonElement | null>;
}) {
  const offered = ROADS.filter(
    (road) => road.id !== "join" || model.requiredNotAccepted.length > 0,
  );
  return (
    <fieldset className="capset__roads" aria-label="Roads in">
      {offered.map((road, at) => (
        <button
          key={road.id}
          ref={at === 0 ? firstRoad : undefined}
          type="button"
          className="road"
          aria-describedby={`caproad-${road.id}`}
          onClick={model.roads[road.id]}
        >
          <span className="road__mark" aria-hidden="true">
            <road.Icon size={20} />
          </span>
          <span className="road__name">{road.name}</span>
          <span className="road__kind" id={`caproad-${road.id}`}>
            {road.kind}
          </span>
        </button>
      ))}
    </fieldset>
  );
}

function Tools({ model }: { model: CapabilitySetupModel }) {
  const approved = model.snapshot.plan?.approvedCapabilities ?? [];
  const publishable = PUBLICATION_CAPABILITIES.some((id) =>
    approved.includes(id),
  );
  return (
    <div className="capset__tools">
      {model.stage === "cards" ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Cancel"
          title="Cancel"
          onClick={model.cancel}
        >
          <IconX size={18} />
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn"
        aria-label="Export instance configuration"
        title="Export instance configuration"
        onClick={() => {
          const file = exportInstanceConfiguration(model.snapshot);
          saveTextFile(file.fileName, file.yaml);
        }}
      >
        <IconDownload size={18} />
      </button>
      {publishable ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Publish deployment configuration"
          title="Publish deployment configuration"
          onClick={() =>
            saveTextFile(
              "os-runtime-config.capabilities.yaml",
              deploymentConfigurationYaml(model.snapshot),
            )
          }
        >
          <IconUpload size={18} />
        </button>
      ) : null}
      {model.stage === "cards" ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Save on this device"
          title="Save on this device"
          disabled={!model.draft}
          onClick={model.edit.review}
        >
          <IconAuthority size={18} />
        </button>
      ) : null}
    </div>
  );
}

function Cards({ model }: { model: CapabilitySetupModel }) {
  const { catalog, draft, snapshot } = model;
  const titleOf = (id: CapabilityId) =>
    catalog.capabilities.find((entry) => entry.id === id)?.title ?? id;
  const ordered = [...catalog.capabilities].sort(
    (a, b) => Number(b.tier === "core") - Number(a.tier === "core"),
  );
  return (
    <ul className="capcards" aria-label="Capabilities">
      {ordered.map((descriptor) => (
        <CapabilityCard
          key={descriptor.id}
          descriptor={descriptor}
          state={snapshot.plan?.capabilities[descriptor.id]}
          lifecycle={snapshot.lifecycle[descriptor.id]}
          selected={
            draft
              ? draft.roots.includes(descriptor.id) ||
                draft.acceptedRequired.includes(descriptor.id)
              : null
          }
          chosenAlternatives={draft?.alternatives ?? {}}
          titleOf={titleOf}
          onToggle={draft ? model.edit.toggle : undefined}
          onChooseAlternative={draft ? model.edit.alternative : undefined}
        />
      ))}
    </ul>
  );
}

function Outcome({ model }: { model: CapabilitySetupModel }) {
  const outcome = model.outcome;
  if (!outcome) return null;
  const tone =
    outcome.status === "durable"
      ? "ok"
      : outcome.status === "session-only"
        ? "warn"
        : "err";
  const label =
    outcome.status === "durable"
      ? "applied · saved on this device"
      : outcome.status === "session-only"
        ? "applied · this session only"
        : `${outcome.status}${outcome.message ? ` · ${outcome.message}` : ""}`;
  return (
    <p className="capout" data-testid="capability-outcome">
      <StatusMark tone={tone} label={label} />
      <span>{label}</span>
    </p>
  );
}

function Join({ model }: { model: CapabilitySetupModel }) {
  if (model.stage !== "join") return null;
  return (
    <InstallationRequirements
      required={model.requiredNotAccepted}
      catalog={model.catalog}
      instanceId={model.snapshot.plan?.identity.instanceId ?? "this instance"}
      onAccept={model.accept}
      onDecline={model.cancel}
    />
  );
}

function Purpose({ model }: { model: CapabilitySetupModel }) {
  const onPurposeStage = model.stage === "purpose" || model.stage === "cards";
  if (!onPurposeStage || model.managed) return null;
  return (
    <PurposeCards
      presets={PRESETS}
      chosen={model.draft?.preset ?? null}
      onChoose={model.edit.preset}
    />
  );
}

function Review({ model }: { model: CapabilitySetupModel }) {
  if (model.stage !== "review" || !model.review) return null;
  return (
    <CapabilityReview
      review={model.review}
      catalog={model.catalog}
      alternativesFor={model.alternatives}
      busy={model.busy}
      onApply={() => void model.apply()}
      onCancel={model.cancel}
      onReplace={model.edit.replace}
    />
  );
}

/**
 * Closing the review — Cancel or Escape — lands the keyboard back on the
 * first road, never nowhere (SURFACE-10).
 */
function useRoadFocus(
  stage: CapabilitySetupModel["stage"],
  firstRoad: React.RefObject<HTMLButtonElement | null>,
): void {
  const wasReviewing = useRef(false);
  useEffect(() => {
    if (stage === "review") wasReviewing.current = true;
    else if (wasReviewing.current && stage === "roads") {
      wasReviewing.current = false;
      landFocus(firstRoad.current);
    }
  }, [stage, firstRoad]);
}

export function CapabilitySetup({ join = false }: { join?: boolean }) {
  const model = useCapabilitySetup(join);
  const firstRoad = useRef<HTMLButtonElement | null>(null);
  useRoadFocus(model.stage, firstRoad);
  const composing = model.stage === "cards" || model.stage === "outcome";
  return (
    <div className="capset" data-testid="capability-setup">
      {model.stage === "roads" ? (
        <Roads model={model} firstRoad={firstRoad} />
      ) : null}
      <Join model={model} />
      <Purpose model={model} />
      {composing ? <Tools model={model} /> : null}
      {composing ? <Cards model={model} /> : null}
      <Review model={model} />
      <Outcome model={model} />
    </div>
  );
}
