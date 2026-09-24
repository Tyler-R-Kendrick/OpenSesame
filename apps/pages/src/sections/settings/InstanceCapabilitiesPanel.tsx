/**
 * Settings › Capabilities — the instance policy, the operator's section.
 *
 * Shown only where the person *is* the operator: a personal-local policy, in
 * the personal tomb, not as a guest. A member of a managed instance never
 * sees a policy control (SURFACE-06) — the section renders nothing, not a
 * disabled form. It is the purpose presets and nothing else: what each
 * capability's policy leaves it is already said where that capability's
 * switch is, and the policy document is the page's Source view, beside the
 * installation's selection (ADR 0138). Choosing a preset writes through
 * `saveLocalInstancePolicy`, the one writer of `capabilities.policy.local.v1`.
 */

import { saveLocalInstancePolicy } from "@opensesame/app-core/lib/configuration/capabilities-adapter.js";
import {
  type CapabilityPreset,
  PRESETS,
  presetToInstancePolicy,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { useState } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { PurposeCards } from "../../screens/capabilities/PurposeCards.js";
import { capabilitySourceSeams } from "./CapabilitiesPanelViews.js";
import { SectionHead } from "./CapabilitySwitch.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

export const instancePanelSeams = {
  now: () => new Date().toISOString(),
};

export function InstanceCapabilitiesPanel() {
  const snapshot = useComposition();
  const { tomb } = useVault();
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
    <section
      className="conn-group capsection"
      id="instance-policy"
      aria-labelledby="instance-policy-title"
      data-testid="instance-capabilities-panel"
    >
      <SectionHead id="instance-policy-title" title="Instance policy" />
      {notice ? (
        <p className="capspanel__notice" role="alert">
          <StatusMark tone="err" label={notice} />
          <span>{notice}</span>
        </p>
      ) : null}
      <PurposeCards
        presets={PRESETS}
        chosen={snapshot.policy?.presetProvenance?.id ?? null}
        onChoose={(preset) => void choosePreset(preset)}
      />
    </section>
  );
}
