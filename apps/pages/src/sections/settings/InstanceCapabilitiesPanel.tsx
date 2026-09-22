/**
 * Settings › Capabilities — the operator view of the instance policy.
 *
 * Shown only where the person *is* the operator: a personal-local policy, in
 * the personal tomb, not as a guest. A member of a managed instance never
 * sees a policy control (SURFACE-06) — the panel renders nothing, not a
 * disabled form. It lists the permitted catalog with each capability's
 * reason codes (`explainCapability`), offers the purpose presets as the
 * instance's policy (written through `saveLocalInstancePolicy`, the one
 * writer of `capabilities.policy.local.v1`), and the Source view of
 * `capabilities/instance-policy.yaml`.
 */

import { useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { saveLocalInstancePolicy } from "../../lib/configuration/capabilities-adapter.js";
import {
  CAPABILITY_CATALOG,
  PRESETS,
  type CapabilityPreset,
  explainCapability,
  presetToInstancePolicy,
  useComposition,
} from "../../lib/configuration/capabilities-ports.js";
import { useVault } from "../../lib/vault/hooks.js";
import { PERSONAL_TOMB } from "../../lib/vfs.js";
import { PurposeCards } from "../../screens/capabilities/PurposeCards.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import {
  CapabilitiesViewToggle,
  CapabilitySourceView,
  type CapabilityView,
  capabilitySourceSeams,
} from "./CapabilitiesPanelViews.js";

export const instancePanelSeams = {
  now: () => new Date().toISOString(),
};

export function InstanceCapabilitiesPanel() {
  const snapshot = useComposition();
  const { tomb, guest } = useVault();
  const [view, setView] = useState<CapabilityView>("visual");
  const [notice, setNotice] = useState<string | null>(null);
  const operator =
    snapshot.provenance === "personal-local" && tomb === PERSONAL_TOMB && !guest;
  if (!operator) return null;
  const plan = snapshot.plan;
  async function choosePreset(preset: CapabilityPreset) {
    const ports = capabilitySourceSeams.ports(tomb);
    const instanceId = plan?.identity.instanceId ?? "personal-local";
    try {
      await saveLocalInstancePolicy(
        ports,
        presetToInstancePolicy(preset, instanceId, `preset-${preset.id}-${instancePanelSeams.now()}`),
      );
      setNotice(null);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "not saved");
    }
  }
  return (
    <div className="panel__body capspanel" data-testid="instance-capabilities-panel">
      <div className="capspanel__head">
        <h3 className="capset__title">Instance policy</h3>
        <CapabilitiesViewToggle view={view} onChange={setView} />
      </div>
      {notice ? (
        <p className="capspanel__notice" role="alert">
          <StatusMark tone="err" label={notice} />
          <span>{notice}</span>
        </p>
      ) : null}
      {view === "visual" ? (
        <>
          <PurposeCards
            presets={PRESETS}
            chosen={snapshot.policy?.presetProvenance?.id ?? null}
            onChoose={(preset) => void choosePreset(preset)}
          />
          <div role="list" aria-label="Permitted catalog">
            {CAPABILITY_CATALOG.capabilities.map((descriptor) => {
              const explanation = plan ? explainCapability(plan, descriptor.id) : null;
              const status = capabilityStatus(explanation?.state, snapshot.lifecycle[descriptor.id]);
              return (
                <div key={descriptor.id} className="capspanel__row" role="listitem">
                  <span className="capspanel__name">
                    <strong>{descriptor.title}</strong>
                    <span>{explanation?.state.reasons.join(" · ") ?? "unresolved"}</span>
                  </span>
                  <StatusMark tone={status.tone} label={status.label} />
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {view === "source" ? <CapabilitySourceView kind="instance-policy" tomb={tomb} /> : null}
      {view === "effective" ? <CapabilitySourceView kind="installation-selection" tomb={tomb} /> : null}
    </div>
  );
}
