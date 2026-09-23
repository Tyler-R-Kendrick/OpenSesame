/**
 * Settings › Capabilities — the operator view of the instance policy.
 *
 * Shown only where the person *is* the operator: a personal-local policy, in
 * the personal tomb, not as a guest. A member of a managed instance never
 * sees a policy control (SURFACE-06) — the panel renders nothing, not a
 * disabled form. It lists the permitted catalog with each capability's
 * reason codes (`explainCapability`) — always-on ones are in every plan and
 * never listed — offers the purpose presets as the
 * instance's policy (written through `saveLocalInstancePolicy`, the one
 * writer of `capabilities.policy.local.v1`), and the Source view of
 * `capabilities/instance-policy.yaml`.
 */

import { saveLocalInstancePolicy } from "@opensesame/app-core/lib/configuration/capabilities-adapter.js";
import { effectivePlanToYaml } from "@opensesame/app-core/lib/configuration/capabilities-document.js";
import {
  CAPABILITY_CATALOG,
  type CapabilityPreset,
  PRESETS,
  explainCapability,
  presetToInstancePolicy,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { PurposeCards } from "../../screens/capabilities/PurposeCards.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import {
  CapabilitiesViewToggle,
  CapabilitySourceView,
  type CapabilityView,
  capabilitySourceSeams,
} from "./CapabilitiesPanelViews.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

import { useComposition } from "../../bindings/capabilities.js";
export const instancePanelSeams = {
  now: () => new Date().toISOString(),
};

export function InstanceCapabilitiesPanel() {
  const snapshot = useComposition();
  const { tomb } = useVault();
  const [view, setView] = useState<CapabilityView>("visual");
  const [notice, setNotice] = useState<string | null>(null);
  const operator = useDeviceOperator();
  if (!operator) return null;
  const plan = snapshot.plan;
  async function choosePreset(preset: CapabilityPreset) {
    const ports = capabilitySourceSeams.ports(tomb);
    const instanceId = plan?.identity.instanceId ?? "personal-local";
    try {
      await saveLocalInstancePolicy(
        ports,
        presetToInstancePolicy(
          preset,
          instanceId,
          `preset-${preset.id}-${instancePanelSeams.now()}`,
        ),
      );
      setNotice(null);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "not saved");
    }
  }
  return (
    <div
      className="panel__body capspanel"
      data-testid="instance-capabilities-panel"
    >
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
          <ul className="capspanel" aria-label="Permitted catalog">
            {CAPABILITY_CATALOG.capabilities
              .filter((descriptor) => descriptor.tier === "optional")
              .map((descriptor) => {
                const explanation = plan
                  ? explainCapability(plan, descriptor.id)
                  : null;
                const status = capabilityStatus(
                  explanation?.state,
                  snapshot.lifecycle[descriptor.id],
                );
                return (
                  <li key={descriptor.id} className="capspanel__row">
                    <span className="capspanel__name">
                      <strong>{descriptor.title}</strong>
                      <span>
                        {explanation?.state.reasons.join(" · ") ?? "unresolved"}
                      </span>
                    </span>
                    <StatusMark tone={status.tone} label={status.label} />
                  </li>
                );
              })}
          </ul>
        </>
      ) : null}
      {view === "source" ? (
        <CapabilitySourceView kind="instance-policy" tomb={tomb} />
      ) : null}
      {view === "effective" ? (
        <pre className="capspanel__source" aria-label="Effective plan">
          {plan ? effectivePlanToYaml(plan) : ""}
        </pre>
      ) : null}
    </div>
  );
}
