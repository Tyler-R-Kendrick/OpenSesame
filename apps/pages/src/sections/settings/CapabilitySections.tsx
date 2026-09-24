/**
 * Settings › Capabilities — every section, drawn one way.
 *
 * A section is a subheader and the tiles configured under it, the same
 * group the Connections catalogue draws (`conn-group`). Where a section has
 * optional capabilities, its switch sits on the subheader: one switch over
 * all of them, through the same review and consent receipt as a single one.
 * A section with more than one optional capability also lists each as a
 * tile with its own switch, beside its providers — so no second list of
 * capabilities is needed anywhere on the page. A section with none is a
 * function every installation has (ADR 0138): the same subheader, no switch.
 *
 * Nothing collapses: a section's providers are drawn whether or not its
 * switch is on, because a connector is configured by reference and binding
 * one needs nothing the switch adds.
 */

import {
  FEATURES,
  type Feature,
  type FeatureProposal,
  featureState,
  isSwitchable,
  switchCapability,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useComposition } from "../../bindings/capabilities.js";
import { StatusMark } from "../../components/StatusMark.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import {
  CapabilitySwitch,
  GuestSection,
  SectionHead,
} from "./CapabilitySwitch.js";
import { ModelProviderPanel } from "./ModelProviderPanel.js";
import { ProviderTiles } from "./ProviderTiles.js";

type Propose = (proposal: FeatureProposal) => void;

function titleOf(id: CapabilityId): string {
  return (
    CAPABILITY_CATALOG.capabilities.find((entry) => entry.id === id)?.title ??
    id
  );
}

/** The section's own switch, or the mark that says why it has none. */
function SectionSwitch({
  feature,
  current,
  onPropose,
}: {
  feature: Feature;
  current: FeatureProposal;
  onPropose: Propose;
}) {
  const { plan } = useComposition();
  const state = featureState(feature, plan);
  if (!state.on && state.available.length === 0) {
    // Nothing here can run: say why, in the first capability's own words.
    const status = capabilityStatus(
      plan?.capabilities[feature.capabilities[0] ?? ""],
      undefined,
    );
    return <StatusMark tone={status.tone} label={status.label} />;
  }
  const only =
    feature.capabilities.length === 1 ? feature.capabilities[0] : undefined;
  return (
    <CapabilitySwitch
      label={feature.title}
      capabilityTitle={only ? titleOf(only) : undefined}
      on={state.on}
      // Reads "on" while anything runs, so pressing it turns the section
      // off; a partly-on section is completed from its tiles.
      onToggle={() =>
        onPropose(
          switchFeature(current, feature, !state.on, plan, CAPABILITY_CATALOG),
        )
      }
    />
  );
}

/** One optional capability of a section with several, as a tile. */
function CapabilityTile({
  feature,
  id,
  current,
  onPropose,
}: {
  feature: Feature;
  id: CapabilityId;
  current: FeatureProposal;
  onPropose: Propose;
}) {
  const snapshot = useComposition();
  const state = snapshot.plan?.capabilities[id];
  const on = state?.approved === true;
  const switchable = on || (state?.distributed === true && state.permitted);
  const title = titleOf(id);
  const status = capabilityStatus(state, snapshot.lifecycle[id]);
  return (
    <li className={`conn-tile${on ? " is-on" : ""}`}>
      <div className="conn-tile__row">
        <span className="conn-tile__link capsection__cap">
          <ConnectorMark providerId={id} displayName={title} size={32} />
          <span className="conn-tile__copy">
            <span className="conn-tile__name">{title}</span>
          </span>
          {switchable ? null : (
            <StatusMark tone={status.tone} label={status.label} />
          )}
        </span>
        {switchable ? (
          <CapabilitySwitch
            label={title}
            capabilityTitle={title}
            on={on}
            onToggle={() =>
              onPropose(
                switchCapability(
                  current,
                  feature,
                  id,
                  !on,
                  snapshot.plan,
                  CAPABILITY_CATALOG,
                ),
              )
            }
          />
        ) : null}
      </div>
    </li>
  );
}

type SectionProps = {
  feature: Feature;
  current: FeatureProposal;
  onPropose: Propose;
  sectionRef?: (element: HTMLElement | null) => void;
};

function CapabilitySection({
  feature,
  current,
  onPropose,
  sectionRef,
}: SectionProps) {
  const tiles = feature.capabilities.length > 1;
  return (
    <section
      className="conn-group capsection"
      id={`feature-${feature.id}`}
      aria-label={feature.title}
      ref={sectionRef}
    >
      <SectionHead title={feature.title}>
        {isSwitchable(feature) ? (
          <SectionSwitch
            feature={feature}
            current={current}
            onPropose={onPropose}
          />
        ) : null}
      </SectionHead>
      {tiles ? (
        <ul className="conn-grid" aria-label={`${feature.title} capabilities`}>
          {feature.capabilities.map((id) => (
            <CapabilityTile
              key={id}
              feature={feature}
              id={id}
              current={current}
              onPropose={onPropose}
            />
          ))}
        </ul>
      ) : null}
      {feature.models ? (
        <GuideTarget id="settings.model-provider">
          <ModelProviderPanel embedded />
        </GuideTarget>
      ) : null}
      {feature.providerCategories.map((category) => (
        <ProviderTiles
          key={category}
          category={category}
          label={`${feature.title} providers`}
        />
      ))}
    </section>
  );
}

/** The backup guide points at the Backups section. */
function BackupsSection(props: SectionProps) {
  return (
    <CapabilitySection
      {...props}
      sectionRef={useGuideTarget<HTMLElement>("settings.backup")}
    />
  );
}

export function CapabilitySections({
  current,
  onPropose,
}: {
  current: FeatureProposal;
  onPropose: Propose;
}) {
  const ref = useGuideTarget<HTMLDivElement>("settings.connectivity");
  return (
    <div className="capsections" id="settings-connections" ref={ref}>
      <GuestSection />
      {FEATURES.map((feature) => {
        const Section =
          feature.id === "backups" ? BackupsSection : CapabilitySection;
        return (
          <Section
            key={feature.id}
            feature={feature}
            current={current}
            onPropose={onPropose}
          />
        );
      })}
    </div>
  );
}
