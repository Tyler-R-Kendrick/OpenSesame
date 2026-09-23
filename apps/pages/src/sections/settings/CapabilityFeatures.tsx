/**
 * Settings › Capabilities — the features, one switch each.
 *
 * A feature is how a person uses OpenSesame (AI, Backups, Payments,
 * Servers, Sharing, Networking, …), not a catalog id. Its switch proposes
 * every optional capability behind it at once — through the same review and
 * consent receipt as a single one — and while it is on, the providers it
 * binds to are configured right under it. Always-on functions have no row
 * here at all: there is nothing about them to switch. Their providers are
 * configured below, in `CapabilityProviders`.
 *
 * "Allow guests" is the one switch that is not a capability: the guest road
 * is core and on by default, and only its operator may take it away.
 */

import {
  FEATURES,
  type Feature,
  type FeatureProposal,
  featureState,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { setGuestsAllowed } from "@opensesame/app-core/lib/guest-access.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { useComposition } from "../../bindings/capabilities.js";
import { useGuestsAllowed } from "../../bindings/guest-access.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ModelProviderPanel } from "./ModelProviderPanel.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { useDeviceOperator } from "./useDeviceOperator.js";

type Standing = Readonly<{ tone: StatusTone; label: string }>;

function standingOf(feature: Feature, plan: EffectivePlan | null): Standing {
  const state = featureState(feature, plan);
  if (state.on) {
    // Counted against what this plan can run, not the catalog: a member an
    // operator prohibited is not something this row can still offer.
    return state.complete
      ? { tone: "ok", label: "on" }
      : {
          tone: "ok",
          label: `on · ${state.approved.length} of ${state.available.length}`,
        };
  }
  if (state.available.length > 0) return { tone: "idle", label: "off" };
  // Nothing here can run: say why, in the first capability's own words.
  const first = feature.capabilities[0];
  return first
    ? capabilityStatus(plan?.capabilities[first], undefined)
    : { tone: "idle", label: "off" };
}

function Switch({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={on}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onToggle}
    />
  );
}

/** The providers a feature binds to, drawn while it is on. */
function FeatureProviders({ feature }: { feature: Feature }) {
  if (!feature.models && feature.providerCategories.length === 0) return null;
  return (
    <div className="capfeature__providers">
      {feature.models ? (
        <GuideTarget id="settings.model-provider">
          <ModelProviderPanel />
        </GuideTarget>
      ) : null}
      {feature.providerCategories.map((category) => (
        <ProviderTiles
          key={category}
          category={category}
          label={`${feature.title} providers`}
        />
      ))}
    </div>
  );
}

type RowProps = {
  feature: Feature;
  current: FeatureProposal;
  onPropose: (proposal: FeatureProposal) => void;
  rowRef?: (element: HTMLLIElement | null) => void;
};

function FeatureRow({ feature, current, onPropose, rowRef }: RowProps) {
  const { plan } = useComposition();
  const state = featureState(feature, plan);
  const standing = standingOf(feature, plan);
  const switchable = state.on || state.available.length > 0;
  return (
    <li className="capfeature" id={`feature-${feature.id}`} ref={rowRef}>
      <div className="capspanel__row">
        <span className="capspanel__name">
          <strong>{feature.title}</strong>
          <span>{standing.label}</span>
        </span>
        <span className="capspanel__side">
          {/* The switch says on or off; a mark only says what it cannot. */}
          {!switchable || (state.on && !state.complete) ? (
            <StatusMark tone={standing.tone} label={standing.label} />
          ) : null}
          {switchable ? (
            <Switch
              label={feature.title}
              on={state.on}
              onToggle={() =>
                onPropose(
                  switchFeature(
                    current,
                    feature,
                    // A partly-on feature completes; a whole one turns off.
                    !state.on || !state.complete,
                    plan,
                    CAPABILITY_CATALOG,
                  ),
                )
              }
            />
          ) : null}
        </span>
      </div>
      {state.on ? <FeatureProviders feature={feature} /> : null}
    </li>
  );
}

/** The backup guide points at the Backups row whether or not it is on. */
function BackupsRow(props: RowProps) {
  return (
    <FeatureRow
      {...props}
      rowRef={useGuideTarget<HTMLLIElement>("settings.backup")}
    />
  );
}

/**
 * Allow guests — the operator's switch alone (`useDeviceOperator`). A guest
 * never sees it, so the one person holding the device on the guest road
 * cannot shut that road behind themselves; neither can a member of a
 * managed instance or someone in a project tomb.
 */
function GuestRow() {
  const allowed = useGuestsAllowed();
  if (!useDeviceOperator()) return null;
  const label = allowed ? "on" : "off";
  return (
    <li className="capfeature" id="feature-guests">
      <div className="capspanel__row">
        <span className="capspanel__name">
          <strong>Guests</strong>
          <span>{label}</span>
        </span>
        <span className="capspanel__side">
          <Switch
            label="Allow guests"
            on={allowed}
            onToggle={() => void setGuestsAllowed(!allowed)}
          />
        </span>
      </div>
    </li>
  );
}

export function CapabilityFeatures({
  current,
  onPropose,
}: {
  current: FeatureProposal;
  onPropose: (proposal: FeatureProposal) => void;
}) {
  return (
    <ul className="capfeatures" aria-label="Features">
      <GuestRow />
      {FEATURES.map((feature) => {
        const Row = feature.id === "backups" ? BackupsRow : FeatureRow;
        return (
          <Row
            key={feature.id}
            feature={feature}
            current={current}
            onPropose={onPropose}
          />
        );
      })}
    </ul>
  );
}
