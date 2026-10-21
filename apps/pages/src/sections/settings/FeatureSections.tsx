/**
 * Settings › Features — every section, drawn one way.
 *
 * A section is a subheader and the switch on it: one switch over all of the
 * section's optional capabilities, through the same review and consent
 * receipt as a single one. A section with more than one also lists each as
 * a switch row with its own switch, so no second list or card style is
 * needed anywhere on the page. Each row opens that feature's own page; no
 * configuration panel is drawn on this list. A section with nothing to
 * switch on this device is not drawn (ADR 0158). The third-party services a
 * feature connects to are configured on Settings › Integrations, and nothing
 * here waits on them (ADR 0189).
 */

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
import { Link } from "react-router";
import { useComposition } from "../../bindings/capabilities.js";
import { IconChevronRight } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { capabilityStatus } from "../../screens/capabilities/status.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  CapabilitySwitch,
  GuestSection,
  SectionHead,
} from "./CapabilitySwitch.js";
import { WithdrawnMark, titleOf } from "./SectionMarks.js";
import { featureConfigPath } from "./feature-config-path.js";

/**
 * The `settings-panel` category a feature's own page reads
 * (`features.feature-<id>`). The list never draws these panels inline.
 */
export function sectionCategory(sectionId: string): string {
  return `features.${sectionId}`;
}

type Propose = (proposal: FeatureProposal) => void;

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
export function BesideSwitch({ id }: { id: CapabilityId | undefined }) {
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
      {feature.capabilities.length > 1 ? (
        <span className="capsection__all">All</span>
      ) : null}
      {/* A section with several capabilities marks each on its row. */}
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

/** One optional capability of a section with several, as a switch row. */
function CapabilityRow({
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
    <li className="sw capsection__cap">
      <Link className="capsection__link" to={featureConfigPath(feature.id, id)}>
        <span className="sw__name">{title}</span>
        <IconChevronRight className="capsection__go" size={14} />
      </Link>
      {switchable ? (
        <span className="capsection__controls">
          <BesideSwitch id={id} />
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
        </span>
      ) : (
        <StatusMark tone={status.tone} label={status.label} />
      )}
    </li>
  );
}

type SectionProps = {
  feature: Feature;
  current: FeatureProposal;
  onPropose: Propose;
  /** The first section drawn: its subheader stands for the list in a tutorial. */
  first?: boolean;
};

function CapabilitySection({
  feature,
  current,
  onPropose,
  first = false,
}: SectionProps) {
  const { plan } = useComposition();
  const ownHead = useGuideTarget<HTMLDivElement>(`feature.${feature.id}`);
  const listHead = useGuideTarget<HTMLDivElement>("settings.features-list");
  const headRef = useCallback(
    (element: HTMLDivElement | null) => {
      ownHead(element);
      if (first) listHead(element);
    },
    [ownHead, listHead, first],
  );
  const identityApi = useIdentityConfigured();
  const several = feature.capabilities.length > 1;
  const id = `feature-${feature.id}`;
  // A subheader over nothing is not drawn: no switch on this device (ADR 0158).
  if (!isSwitchable(feature, plan, { identityApi })) return null;
  return (
    <section className="capsection" id={id} aria-labelledby={`${id}-title`}>
      <SectionHead
        id={`${id}-title`}
        title={feature.title}
        headRef={headRef}
        {...(several ? {} : { to: featureConfigPath(feature.id) })}
      >
        <WithdrawnMark backedBy={feature.backedBy} />
        <SectionSwitch
          feature={feature}
          current={current}
          onPropose={onPropose}
        />
      </SectionHead>
      {several ? (
        <ul
          className="capsection__caps"
          aria-label={`${feature.title} capabilities`}
        >
          {feature.capabilities.map((id) => (
            <CapabilityRow
              key={id}
              feature={feature}
              id={id}
              current={current}
              onPropose={onPropose}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function FeatureSections({
  current,
  onPropose,
}: {
  current: FeatureProposal;
  onPropose: Propose;
}) {
  const { plan } = useComposition();
  const identityApi = useIdentityConfigured();
  const context = { identityApi };
  const features = FEATURES.map((feature) => shown(feature, plan, context));
  const first = features.find((feature) =>
    isSwitchable(feature, plan, context),
  )?.id;
  return (
    <div className="capsections" id="settings-features">
      <GuestSection />
      {features.map((feature) => (
        <CapabilitySection
          key={feature.id}
          feature={feature}
          current={current}
          onPropose={onPropose}
          first={feature.id === first}
        />
      ))}
    </div>
  );
}
