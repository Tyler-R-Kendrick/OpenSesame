/**
 * Settings › Features — the instance policy, the operator's section.
 *
 * Shown only where the person *is* the operator: a personal-local policy, in
 * the personal tomb, not as a guest. A member of a managed instance never
 * sees a policy control (SURFACE-06) — the section renders nothing, not a
 * disabled form. It is the purpose presets and nothing else: what each
 * capability's policy leaves it is already said where that capability's
 * switch is, and the policy document is `settings/features/instance-policy.yaml`,
 * beside the installation's selection (ADR 0134, ADR 0142). Choosing a preset writes through
 * `saveLocalInstancePolicy`, the one writer of `capabilities.policy.local.v1`.
 */

import { saveLocalInstancePolicy } from "@opensesame/app-core/lib/configuration/capabilities-adapter.js";
import {
  type CapabilityPreset,
  capabilityPorts,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { defaultCapabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-resources.js";
import { useState } from "react";
import { Link } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconChevronRight } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { PurposeCards } from "../../screens/capabilities/PurposeCards.js";
import { SectionHead } from "./CapabilitySwitch.js";
import { featureConfigPath } from "./feature-config-path.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

export const instancePanelSeams = {
  now: () => new Date().toISOString(),
  save: saveLocalInstancePolicy,
};

export function InstanceCapabilitiesPanel({
  bare = false,
}: {
  bare?: boolean;
} = {}) {
  const snapshot = useComposition();
  const { tomb } = useVault();
  const [notice, setNotice] = useState<string | null>(null);
  const operator = useDeviceOperator();
  if (!operator) return null;
  const plan = snapshot.plan;
  async function choosePreset(preset: CapabilityPreset) {
    const ports = defaultCapabilityPorts(() => tomb);
    const instanceId = plan?.identity.instanceId ?? "personal-local";
    try {
      await instancePanelSeams.save(
        ports,
        capabilityPorts.presetToInstancePolicy(
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
  const body = (
    <>
      <FailureNotice
        id="settings:instance-policy"
        title="Instance policy"
        message={notice}
      />
      <PurposeCards
        presets={capabilityPorts.PRESETS}
        chosen={snapshot.policy?.presetProvenance?.id ?? null}
        onChoose={(preset) => void choosePreset(preset)}
      />
    </>
  );
  if (bare) return body;
  return (
    <section
      className="capsection"
      id="instance-policy"
      aria-labelledby="instance-policy-title"
      data-testid="instance-capabilities-panel"
    >
      <SectionHead id="instance-policy-title" title="Instance policy">
        {notice === null ? null : <StatusMark tone="err" label={notice} />}
      </SectionHead>
      {body}
    </section>
  );
}

/** The Features row that opens the operator's policy page. */
export function InstancePolicyLink() {
  if (!useDeviceOperator()) return null;
  return (
    <section className="capsection" id="instance-policy">
      <div className="capsection__head">
        <Link
          className="capsection__titlelink"
          to={featureConfigPath("instance-policy")}
        >
          <h3 className="capsection__title">Instance policy</h3>
          <IconChevronRight className="capsection__go" size={14} />
        </Link>
      </div>
    </section>
  );
}
