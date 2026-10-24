/**
 * One feature's own Settings page.
 *
 * Features is a list of rows: a switch, a name, and a way into the settings
 * that feature owns. The panels those settings used to draw inline on
 * Features live here, so the list never becomes a configuration page.
 */

import {
  FEATURES,
  type Feature,
  type FeatureProposal,
  dependentsOf,
  featureState,
  heldOutside,
  neededBy,
  shown,
  switchCapability,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { setGuestsAllowed } from "@opensesame/app-core/lib/guest-access.js";
import { pluginForCapability } from "@opensesame/app-core/lib/plugins/catalog.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { useContributions } from "../../bindings/contributions.js";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { FieldRow } from "../../components/FieldRow.js";
import { IconChevronLeft } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import { CapabilitySwitch, useGuestRowShown } from "./CapabilitySwitch.js";
import { BesideSwitch, sectionCategory } from "./FeatureSections.js";
import { InstanceCapabilitiesPanel } from "./InstanceCapabilitiesPanel.js";
import { titleOf } from "./SectionMarks.js";
import { useCapabilityChange } from "./useCapabilityChange.js";

/**
 * A capability's panel is registered under its feature category, not under
 * the capability. These are the panels Features used to draw inline, named
 * for the row that now owns each one.
 */
const PANELS_BY_CAPABILITY = new Map(
  Object.entries({
    "support.local-ai": ["model-provider"],
    "support.remote-ai": ["model-provider"],
    "sharing.relay": ["org-vault-directory"],
    "vault.security-checks": ["capability-security-checks"],
    "ai.password-reset": ["password-reset-mail"],
    "notifications.local": ["local-notifications"],
    "networking.tailnet": ["tailnet-sync"],
    "networking.tailnet-devices": ["tailnet-sync"],
    "sharing.trusted-contacts": ["trusted-contacts"],
  }),
);

function panelIdsFor(capabilityId: string): readonly string[] {
  const known = PANELS_BY_CAPABILITY.get(capabilityId) ?? [];
  const plugin = pluginForCapability(capabilityId);
  return [...known, ...(plugin ? [`plugin-${plugin.id}`] : [])];
}

function BackToFeatures() {
  return (
    <Link className="feature-config__back" to="/settings/features">
      <IconChevronLeft size={14} />
      Features
    </Link>
  );
}

function WholeFeatureSwitch({
  feature,
  current,
  onPropose,
  plan,
}: {
  feature: Feature;
  current: FeatureProposal;
  onPropose: (proposal: FeatureProposal) => void;
  plan: CompositionSnapshot["plan"];
}) {
  const state = featureState(feature, plan);
  const held = state.on ? heldOutside(plan, feature) : [];
  if (held.length > 0) {
    return (
      <StatusMark
        tone="ok"
        label={`needed by ${held.map(titleOf).join(", ")}`}
      />
    );
  }
  if (!state.on && state.available.length === 0) {
    const status = capabilityStatus(
      plan?.capabilities[feature.capabilities[0] ?? ""],
      undefined,
    );
    return <StatusMark tone={status.tone} label={status.label} />;
  }
  return (
    <span className="capsection__controls">
      <BesideSwitch id={feature.capabilities[0]} />
      <CapabilitySwitch
        label={feature.title}
        on={state.on}
        onToggle={() =>
          onPropose(
            switchFeature(
              current,
              feature,
              !state.on,
              plan,
              capabilityPorts.CAPABILITY_CATALOG,
            ),
          )
        }
      />
    </span>
  );
}

function FeatureSwitch({
  feature,
  capabilityId,
  current,
  onPropose,
}: {
  feature: Feature;
  capabilityId?: string;
  current: FeatureProposal;
  onPropose: (proposal: FeatureProposal) => void;
}) {
  const snapshot = useComposition();
  if (capabilityId === undefined) {
    return (
      <WholeFeatureSwitch
        feature={feature}
        current={current}
        onPropose={onPropose}
        plan={snapshot.plan}
      />
    );
  }

  const id = capabilityId;
  const state = snapshot.plan?.capabilities[id];
  const on = state?.approved === true;
  const needers = on
    ? [
        ...new Set([
          ...neededBy(current, id, capabilityPorts.CAPABILITY_CATALOG),
          ...dependentsOf(snapshot.plan, id),
        ]),
      ]
    : [];
  const switchable =
    needers.length === 0 &&
    (on || (state?.distributed === true && state.permitted));
  if (!switchable) {
    const status =
      needers.length > 0
        ? {
            tone: "ok" as const,
            label: `needed by ${needers.map(titleOf).join(", ")}`,
          }
        : capabilityStatus(state, snapshot.lifecycle[id]);
    return <StatusMark tone={status.tone} label={status.label} />;
  }
  return (
    <span className="capsection__controls">
      <BesideSwitch id={id} />
      <CapabilitySwitch
        label={titleOf(id)}
        capabilityTitle={titleOf(id)}
        on={on}
        onToggle={() =>
          onPropose(
            switchCapability(
              current,
              feature,
              id,
              !on,
              snapshot.plan,
              capabilityPorts.CAPABILITY_CATALOG,
            ),
          )
        }
      />
    </span>
  );
}

function Panel({
  title,
  back = true,
  children,
  action,
}: {
  title: string;
  back?: boolean;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel feature-config">
      <div className="panel__head">
        <div>
          {back ? <BackToFeatures /> : null}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}

function GuestsConfig() {
  const allowed = useGuestsAllowed();
  const shown = useGuestRowShown();
  if (!shown) {
    return (
      <Panel title="Guests">
        <StatusMark
          tone="warn"
          label="Guests are not available in this vault."
        />
      </Panel>
    );
  }
  return (
    <Panel
      title="Guests"
      action={
        <CapabilitySwitch
          label="Allow guests"
          on={allowed}
          onToggle={() => void setGuestsAllowed(!allowed)}
        />
      }
    >
      <FieldRow label="Guest vault">
        <span className="frow__value">Separate · ephemeral</span>
      </FieldRow>
      <FieldRow label="This vault">
        <span className="frow__value">Key and items stay private</span>
      </FieldRow>
    </Panel>
  );
}

function InstancePolicyConfig() {
  return (
    <Panel title="Instance policy" back>
      <InstanceCapabilitiesPanel bare />
    </Panel>
  );
}

function FeaturePage({
  feature,
  selectedCapability,
}: {
  feature: Feature;
  selectedCapability?: CapabilityId;
}) {
  const change = useCapabilityChange();
  const panels = useContributions("settings-panel");
  const ids =
    selectedCapability === undefined ? null : panelIdsFor(selectedCapability);
  const own =
    ids === null
      ? panels.filter(
          (panel) =>
            panel.category === sectionCategory(`feature-${feature.id}`),
        )
      : panels.filter((panel) => ids.includes(panel.id));
  const title =
    selectedCapability === undefined
      ? feature.title
      : titleOf(selectedCapability);
  return (
    <Panel
      title={title}
      action={
        <FeatureSwitch
          feature={feature}
          capabilityId={selectedCapability}
          current={change.current}
          onPropose={change.propose}
        />
      }
    >
      {change.notice ? <StatusMark tone="err" label={change.notice} /> : null}
      {own.map(({ id, Panel: OwnPanel }) => (
        <OwnPanel key={id} />
      ))}
    </Panel>
  );
}

export function FeatureConfigPanel({
  featureId,
  capabilityId,
}: {
  featureId: string;
  capabilityId?: string;
}) {
  const snapshot = useComposition();
  const identityApi = useIdentityConfigured();
  if (featureId === "guests") return <GuestsConfig />;
  if (featureId === "instance-policy") return <InstancePolicyConfig />;
  const rawFeature = FEATURES.find((entry) => entry.id === featureId);
  const feature = rawFeature
    ? shown(rawFeature, snapshot.plan, { identityApi })
    : undefined;
  if (!feature || feature.capabilities.length === 0) {
    return (
      <Panel title="Feature not found">
        <StatusMark
          tone="warn"
          label="This feature is not installed on this device."
        />
      </Panel>
    );
  }
  const selectedCapability =
    capabilityId !== undefined && feature.capabilities.includes(capabilityId)
      ? capabilityId
      : undefined;
  if (capabilityId !== undefined && selectedCapability === undefined) {
    return (
      <Panel title="Feature not found">
        <StatusMark
          tone="warn"
          label={`${feature.title} has no ${capabilityId} capability.`}
        />
      </Panel>
    );
  }
  return (
    <FeaturePage feature={feature} selectedCapability={selectedCapability} />
  );
}
