/**
 * Settings › Capabilities — how this installation is used.
 *
 * One list of sections, each drawn the same way (`CapabilitySections`): a
 * subheader, the switch on it where the section has optional capabilities,
 * and the tiles configured under it. Guests first; then identity, keys,
 * storage, sharing, payments, AI, networking, notifications and telemetry;
 * then, for the operator of this device, the instance policy
 * (`InstanceCapabilitiesPanel`, never shown to a member — SURFACE-06).
 *
 * A switch proposes roots; the review and Apply are one ceremony
 * (`useCapabilityChange`). Visual, Source and Effective are the page's three
 * views of the same documents — one toggle for all of them. Source shows
 * the installation's selection and, to the operator, the instance policy,
 * each committed through the S04 adapter; Effective is read-only.
 */

import { withdrawnAlwaysOn } from "@opensesame/app-core/lib/capabilities/features.js";
import { effectivePlanToYaml } from "@opensesame/app-core/lib/configuration/capabilities-document.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { alternativesFor } from "../../screens/capabilities/CapabilityDraft.js";
import { CapabilityReview } from "../../screens/capabilities/CapabilityReview.js";
import {
  CapabilitiesViewToggle,
  CapabilitySourceView,
  type CapabilityView,
} from "./CapabilitiesPanelViews.js";
import { CapabilitySections } from "./CapabilitySections.js";
import { InstanceCapabilitiesPanel } from "./InstanceCapabilitiesPanel.js";
import {
  type CapabilityChange,
  capabilitiesPanelSeams,
  useCapabilityChange,
} from "./useCapabilityChange.js";
import { useDeviceOperator } from "./useDeviceOperator.js";
import "./capabilities.css";

export { capabilitiesPanelSeams } from "./useCapabilityChange.js";

function RestartNotice({ change }: { change: CapabilityChange }) {
  const pending = Object.values(change.snapshot.plan?.capabilities ?? {}).some(
    (state) => state.restartRequired,
  );
  if (!pending) return null;
  return (
    <p className="capspanel__notice" data-testid="capabilities-restart">
      <StatusMark tone="warn" label="restart required" />
      <span>reload to finish unloading</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Reload now"
        title="Reload now"
        onClick={() => capabilitiesPanelSeams.reload()}
      >
        <IconRefresh size={14} />
      </button>
    </p>
  );
}

/**
 * Always-on capabilities this plan does not run: an operator withdrew them
 * (ADR 0139), or they need one that was. Named here, and marked on the
 * section they back, rather than drawn as though they ran.
 */
function WithdrawnNotice({ change }: { change: CapabilityChange }) {
  const withdrawn = withdrawnAlwaysOn(change.snapshot.plan);
  if (withdrawn.length === 0) return null;
  const titles = withdrawn
    .map(
      (id) =>
        capabilityPorts.CAPABILITY_CATALOG.capabilities.find(
          (entry) => entry.id === id,
        )?.title ?? id,
    )
    .join(", ");
  const label = `withdrawn by operator: ${titles}`;
  return (
    <p className="capspanel__notice" data-testid="capabilities-withdrawn">
      <StatusMark tone="warn" label={label} />
      <span>{label}</span>
    </p>
  );
}

function Visual({ change }: { change: CapabilityChange }) {
  if (change.review) {
    return (
      <CapabilityReview
        review={change.review}
        catalog={capabilityPorts.CAPABILITY_CATALOG}
        alternativesFor={(root) =>
          alternativesFor(
            root,
            capabilityPorts.CAPABILITY_CATALOG,
            change.snapshot.plan,
          )
        }
        busy={change.busy}
        onApply={() => void change.apply()}
        onCancel={change.cancel}
        onReplace={change.cancel}
      />
    );
  }
  return (
    <>
      <CapabilitySections current={change.current} onPropose={change.propose} />
      <InstanceCapabilitiesPanel />
    </>
  );
}

export function CapabilitiesPanel() {
  const change = useCapabilityChange();
  const { tomb } = useVault();
  const [view, setView] = useState<CapabilityView>("visual");
  const operator = useDeviceOperator();
  return (
    <section className="panel" data-testid="capabilities-panel">
      <div className="panel__head capspanel__head">
        <h2>Capabilities</h2>
        <CapabilitiesViewToggle view={view} onChange={setView} />
      </div>
      <div className="panel__body capspanel">
        <RestartNotice change={change} />
        <WithdrawnNotice change={change} />
        {change.notice ? (
          <p className="capspanel__notice">
            <StatusMark tone="err" label={change.notice} />
            <span>{change.notice}</span>
          </p>
        ) : null}
        {view === "visual" ? <Visual change={change} /> : null}
        {view === "source" ? (
          <>
            <CapabilitySourceView kind="installation-selection" tomb={tomb} />
            {operator ? (
              <CapabilitySourceView kind="instance-policy" tomb={tomb} />
            ) : null}
          </>
        ) : null}
        {view === "effective" ? (
          <pre className="capspanel__source" aria-label="Effective plan">
            {change.snapshot.plan
              ? effectivePlanToYaml(change.snapshot.plan)
              : ""}
          </pre>
        ) : null}
      </div>
    </section>
  );
}
