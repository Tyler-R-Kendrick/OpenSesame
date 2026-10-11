/**
 * Settings › Features — which optional parts of this installation are on.
 *
 * One list of sections, each drawn the same way (`FeatureSections`): a
 * subheader and the switch on it, with a tile and switch for each capability
 * where a section has several. Guests first; then identity, access, the
 * vault's extras, sharing, payments, AI, networking, notifications and
 * telemetry; then, for the operator of this device, the instance policy
 * (`InstanceCapabilitiesPanel`, never shown to a member — SURFACE-06).
 *
 * A switch commits in place (`useCapabilityChange`). The documents behind
 * the page — the selection, the operator's policy, the effective plan — are
 * files beside this directory's `config.yaml` (`capability-files.ts`), and
 * this page is how each of them is seen: opening any of them from the rail or
 * the address draws this page, never their text. The services a feature
 * connects to are on Settings › Integrations (ADR 0189).
 */

import { withdrawnAlwaysOn } from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { FeatureSections } from "./FeatureSections.js";
import { InstanceCapabilitiesPanel } from "./InstanceCapabilitiesPanel.js";
import {
  type CapabilityChange,
  capabilitiesPanelSeams,
  useCapabilityChange,
} from "./useCapabilityChange.js";
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
 * (ADR 0142), or they need one that was. Named here, and marked on the
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
      <StatusMark tone="err" label={label} />
      <span>{label}</span>
    </p>
  );
}

function Body({ change }: { change: CapabilityChange }) {
  return (
    <>
      <FeatureSections current={change.current} onPropose={change.propose} />
      <InstanceCapabilitiesPanel />
    </>
  );
}

export function FeaturesPanel() {
  const change = useCapabilityChange();
  return (
    <section className="panel" data-testid="features-panel">
      <div className="panel__head capspanel__head">
        <h2>Features</h2>
      </div>
      <div className="panel__body capspanel">
        <RestartNotice change={change} />
        <WithdrawnNotice change={change} />
        {change.notice ? <StatusMark tone="err" label={change.notice} /> : null}
        <FailureNotice
          id="settings:features"
          title="Features"
          message={change.notice}
        />
        <Body change={change} />
      </div>
    </section>
  );
}
