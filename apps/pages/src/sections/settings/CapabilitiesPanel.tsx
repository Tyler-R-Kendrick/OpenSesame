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
 * A switch commits in place (`useCapabilityChange`). The documents behind
 * the page — the selection,
 * the operator's policy, the effective plan — are files beside this
 * directory's `config.yaml` (`capability-files.ts`), opened from the key on
 * the heading or from the rail; there is no second view of the page.
 */

import { withdrawnAlwaysOn } from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { SELECTION_FILE } from "@opensesame/app-core/sections/settings/capability-files.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CapabilitySections } from "./CapabilitySections.js";
import { InstanceCapabilitiesPanel } from "./InstanceCapabilitiesPanel.js";
import { OpenFileKey } from "./files/OpenFileKey.js";
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
      <CapabilitySections current={change.current} onPropose={change.propose} />
      <InstanceCapabilitiesPanel />
    </>
  );
}

export function CapabilitiesPanel() {
  const change = useCapabilityChange();
  return (
    <section className="panel" data-testid="capabilities-panel">
      <div className="panel__head capspanel__head">
        <h2>Capabilities</h2>
        <OpenFileKey path={SELECTION_FILE} name="installation-selection.yaml" />
      </div>
      <div className="panel__body capspanel">
        <RestartNotice change={change} />
        <WithdrawnNotice change={change} />
        {change.notice ? <StatusMark tone="err" label={change.notice} /> : null}
        <FailureNotice
          id="settings:capabilities"
          title="Capabilities"
          message={change.notice}
        />
        <Body change={change} />
      </div>
    </section>
  );
}
