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
 * function every installation has (ADR 0142): the same subheader, no switch.
 *
 * Nothing collapses: a section's providers are drawn whether or not its
 * switch is on, because a connector is configured by reference and binding
 * one needs nothing the switch adds.
 */

import { SECURITY_CHECKS_SUMMARY } from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import {
  FEATURES,
  type Feature,
  type FeatureProposal,
  dependentsOf,
  featureState,
  heldOutside,
  isSwitchable,
  neededBy,
  shown,
  switchCapability,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type { CapabilityId } from "@opensesame/capability-composition";
import { useCallback } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { useContributions } from "../../bindings/contributions.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import {
  CapabilitySwitch,
  GuestSection,
  SectionHead,
} from "./CapabilitySwitch.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { featureDraws } from "./provider-tile-items.js";

/** `support.local-ai`'s model picker, drawn in the AI section once AI is on. */
export const MODEL_PROVIDER_PANEL = "model-provider";

/**
 * The `settings-panel` category that draws a panel inside one section
 * (`capabilities.feature-<id>`) — a category no settings route renders on
 * its own, so the panel appears in its section and nowhere else.
 */
export function sectionCategory(sectionId: string): string {
  return `capabilities.${sectionId}`;
}

type Propose = (proposal: FeatureProposal) => void;

function titleOf(id: CapabilityId): string {
  return (
    capabilityPorts.CAPABILITY_CATALOG.capabilities.find(
      (entry) => entry.id === id,
    )?.title ?? id
  );
}

/** What a switch already says — on or off — needs no mark beside it. */
const SAID_BY_SWITCH: ReadonlySet<string> = new Set([
  "active",
  "approved",
  "deselected",
]);

/**
 * The mark a switchable capability wears beside its switch: only what the
 * switch cannot say (conflict, consent required, restart required, starting,
 * selected · not yet applied …).
 */
function BesideSwitch({ id }: { id: CapabilityId | undefined }) {
  const snapshot = useComposition();
  if (id === undefined) return null;
  const status = capabilityStatus(
    snapshot.plan?.capabilities[id],
    snapshot.lifecycle[id],
  );
  if (SAID_BY_SWITCH.has(status.label)) return null;
  return <StatusMark tone={status.tone} label={status.label} />;
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
  // Running capabilities elsewhere are built on this section's: its switch
  // could not take them off, so it says who needs it (ADR 0158 §3).
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
    <span className="capsection__controls">
      {/* A section with several capabilities marks each on its tile. */}
      <BesideSwitch id={only} />
      <CapabilitySwitch
        label={feature.title}
        capabilityTitle={only ? titleOf(only) : undefined}
        on={state.on}
        // Reads "on" while anything runs, so pressing it turns the section
        // off; a partly-on section is completed from its tiles.
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
  // Household sharing's transport is Shared drops, and Self-issued OpenID runs
  // on Browser-local IAM: switching either off alone would review a change
  // that changes nothing, so its tile says who needs it.
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
  const title = titleOf(id);
  const status =
    needers.length > 0
      ? {
          tone: "ok" as const,
          label: `needed by ${needers.map(titleOf).join(", ")}`,
        }
      : capabilityStatus(state, snapshot.lifecycle[id]);
  return (
    <li className={`conn-tile${on ? " is-on" : ""}`}>
      <div className="conn-tile__row">
        <span className="conn-tile__link capsection__cap">
          <ConnectorMark providerId={id} displayName={title} size={32} />
          <span className="conn-tile__copy">
            <span className="conn-tile__name">{title}</span>
          </span>
          {switchable ? (
            <BesideSwitch id={id} />
          ) : (
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
                  capabilityPorts.CAPABILITY_CATALOG,
                ),
              )
            }
          />
        ) : null}
      </div>
    </li>
  );
}

/** An always-on capability behind this section that an operator withdrew. */
function WithdrawnMark({ feature }: { feature: Feature }) {
  const { plan } = useComposition();
  const withdrawn = (feature.backedBy ?? []).filter((id) => {
    const state = plan?.capabilities[id];
    return state?.tier === "core" && !state.approved;
  });
  if (withdrawn.length === 0) return null;
  const label = `withdrawn by operator: ${withdrawn.map(titleOf).join(", ")}`;
  return <StatusMark tone="err" label={label} />;
}

type SectionProps = {
  feature: Feature;
  current: FeatureProposal;
  onPropose: Propose;
  sectionRef?: (element: HTMLElement | null) => void;
  /** The first section drawn: its subheader stands for the list in a tutorial. */
  first?: boolean;
};

function CapabilitySection({
  feature,
  current,
  onPropose,
  sectionRef,
  first = false,
}: SectionProps) {
  const { plan } = useComposition();
  const roads = useConnectorRoads();
  const ownHead = useGuideTarget<HTMLDivElement>(`feature.${feature.id}`);
  const listHead = useGuideTarget<HTMLDivElement>("settings.connectivity");
  const headRef = useCallback(
    (element: HTMLDivElement | null) => {
      ownHead(element);
      if (first) listHead(element);
    },
    [ownHead, listHead, first],
  );
  const identityApi = useIdentityConfigured();
  const tiles = feature.capabilities.length > 1;
  const id = `feature-${feature.id}`;
  // The model picks configure AI and probe the browser and the harnesses on
  // mount: they are AI's own code, drawn once AI is on — unlike a provider
  // tile, which is a connector configured by reference.
  const models = feature.models === true && featureState(feature, plan).on;
  const panels = useContributions("settings-panel");
  const ModelPanel = panels.find(
    (panel) => panel.id === MODEL_PROVIDER_PANEL,
  )?.Panel;
  // A capability's own panel inside its section (a runtime-installed
  // plugin's state and switch): there only while its module is active.
  const own = panels.filter((panel) => panel.category === sectionCategory(id));
  // A subheader over nothing is not drawn: no switch and no connector whose
  // page has something to do on this device (ADR 0158).
  if (!featureDraws(feature, roads.tile, plan, { identityApi })) return null;
  return (
    <section
      className="conn-group capsection"
      id={id}
      aria-labelledby={`${id}-title`}
      ref={sectionRef}
    >
      <SectionHead id={`${id}-title`} title={feature.title} headRef={headRef}>
        <WithdrawnMark feature={feature} />
        {isSwitchable(feature, plan, { identityApi }) ? (
          <SectionSwitch
            feature={feature}
            current={current}
            onPropose={onPropose}
          />
        ) : null}
      </SectionHead>
      {feature.id === "security-checks" && own.length === 0 ? (
        <p className="capsection__summary">{SECURITY_CHECKS_SUMMARY}</p>
      ) : null}
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
      {models && ModelPanel ? (
        <GuideTarget id="settings.model-provider">
          <ModelPanel />
        </GuideTarget>
      ) : null}
      {own.map(({ id: panelId, Panel }) => (
        <Panel key={panelId} />
      ))}
      {feature.providerCategories.map((category) => (
        <ProviderTiles
          key={category}
          category={category}
          label={
            feature.title.endsWith("providers")
              ? feature.title
              : `${feature.title} providers`
          }
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
  const { plan } = useComposition();
  const roads = useConnectorRoads();
  const identityApi = useIdentityConfigured();
  const context = { identityApi };
  const features = FEATURES.map((feature) => shown(feature, plan, context));
  const first = features.find((feature) =>
    featureDraws(feature, roads.tile, plan, context),
  )?.id;
  return (
    <div className="capsections" id="settings-connections">
      <GuestSection />
      {features.map((feature) => {
        const Section =
          feature.id === "backups" ? BackupsSection : CapabilitySection;
        return (
          <Section
            key={feature.id}
            feature={feature}
            current={current}
            onPropose={onPropose}
            first={feature.id === first}
          />
        );
      })}
    </div>
  );
}
