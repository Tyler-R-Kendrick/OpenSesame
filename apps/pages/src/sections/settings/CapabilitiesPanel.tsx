/**
 * Settings › Capabilities — how this installation is used.
 *
 * Features first: one switch per way of using OpenSesame (AI, Backups,
 * Payments, Servers, Sharing, Networking, Notifications, Telemetry) plus
 * Allow guests, each feature's providers configured right under it while it
 * is on. Then the providers of the always-on functions, which have no switch
 * because nothing about them can be turned off. Then Advanced: the optional
 * capabilities one by one and, for the operator of this device, the instance
 * policy (`InstanceCapabilitiesPanel`, never shown to a member — SURFACE-06).
 *
 * A switch or an Advanced row proposes roots; the review and Apply are one
 * ceremony (`useCapabilityChange`). Visual, Source and Effective are three
 * views of the same documents; Source commits through the S04 adapter,
 * Effective is read-only.
 */

import { effectivePlanToYaml } from "@opensesame/app-core/lib/configuration/capabilities-document.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
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
import { CapabilityFeatures } from "./CapabilityFeatures.js";
import { CapabilityProviders } from "./CapabilityProviders.js";
import { CapabilityRows } from "./CapabilityRows.js";
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

function Visual({ change }: { change: CapabilityChange }) {
  if (change.review) {
    return (
      <CapabilityReview
        review={change.review}
        catalog={CAPABILITY_CATALOG}
        alternativesFor={(root) =>
          alternativesFor(root, CAPABILITY_CATALOG, change.snapshot.plan)
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
      <CapabilityFeatures current={change.current} onPropose={change.propose} />
      <CapabilityProviders />
      <details className="capadvanced" data-testid="capabilities-advanced">
        <summary>Advanced</summary>
        <CapabilityRows current={change.current} onPropose={change.propose} />
        <InstanceCapabilitiesPanel />
      </details>
    </>
  );
}

export function CapabilitiesPanel() {
  const change = useCapabilityChange();
  const { tomb } = useVault();
  const [view, setView] = useState<CapabilityView>("visual");
  return (
    <section className="panel" data-testid="capabilities-panel">
      <div className="panel__head capspanel__head">
        <h2>Capabilities</h2>
        <CapabilitiesViewToggle view={view} onChange={setView} />
      </div>
      <div className="panel__body capspanel">
        <RestartNotice change={change} />
        {change.notice ? (
          <p className="capspanel__notice">
            <StatusMark tone="err" label={change.notice} />
            <span>{change.notice}</span>
          </p>
        ) : null}
        {view === "visual" ? <Visual change={change} /> : null}
        {view === "source" ? (
          <CapabilitySourceView kind="installation-selection" tomb={tomb} />
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
