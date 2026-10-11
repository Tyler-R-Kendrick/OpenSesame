/**
 * Settings › Integrations — every section, drawn one way.
 *
 * An integration is a third party's service a feature connects to, to extend
 * it or to replace what it does on its own (ADR 0188). A section is a
 * subheader and the connector tiles configured under it, the same group the
 * Connections catalogue draws (`conn-group`). Nothing here is a switch and
 * nothing is reviewed: a connector is configured by reference, its page sealing
 * the credential in the vault, so a section is drawn whether or not the feature
 * it extends is on. A section with no connector that has anything to do on
 * this device is not drawn (ADR 0158).
 */

import type { Integration } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { useCallback } from "react";
import { useContributions } from "../../bindings/contributions.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { SectionHead } from "./CapabilitySwitch.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { WithdrawnMark } from "./SectionMarks.js";
import {
  type DrawnIntegration,
  MODEL_PROVIDER_PANEL,
  useIntegrationsDrawn,
} from "./use-integrations-drawn.js";

type SectionProps = {
  integration: Integration;
  /** The model picks draw here: the feature they configure is on. */
  models: boolean;
  /** The first section drawn: its subheader stands for the list in a tutorial. */
  first: boolean;
  sectionRef?: (element: HTMLElement | null) => void;
};

function IntegrationSection({
  integration,
  models,
  first,
  sectionRef,
}: SectionProps) {
  const ownHead = useGuideTarget<HTMLDivElement>(
    `integration.${integration.id}`,
  );
  const listHead = useGuideTarget<HTMLDivElement>("settings.integrations-list");
  const headRef = useCallback(
    (element: HTMLDivElement | null) => {
      ownHead(element);
      if (first) listHead(element);
    },
    [ownHead, listHead, first],
  );
  const id = `integration-${integration.id}`;
  const ModelPanel = useContributions("settings-panel").find(
    (panel) => panel.id === MODEL_PROVIDER_PANEL,
  )?.Panel;
  return (
    <section
      className="conn-group capsection"
      id={id}
      aria-labelledby={`${id}-title`}
      ref={sectionRef}
    >
      <SectionHead
        id={`${id}-title`}
        title={integration.title}
        headRef={headRef}
      >
        <WithdrawnMark backedBy={integration.backedBy} />
      </SectionHead>
      {models && ModelPanel ? (
        <GuideTarget id="settings.model-provider">
          <ModelPanel />
        </GuideTarget>
      ) : null}
      {integration.providerCategories.map((category) => (
        <ProviderTiles
          key={category}
          category={category}
          label={
            integration.title.endsWith("providers")
              ? integration.title
              : `${integration.title} providers`
          }
        />
      ))}
    </section>
  );
}

/** The backup guide points at the Backups section. */
function BackupsSection(props: SectionProps) {
  return (
    <IntegrationSection
      {...props}
      sectionRef={useGuideTarget<HTMLElement>("settings.backup")}
    />
  );
}

export function IntegrationSections() {
  const drawn: readonly DrawnIntegration[] = useIntegrationsDrawn();
  return (
    <div className="capsections" id="settings-integrations">
      {drawn.map(({ integration, models }, index) => {
        const Section =
          integration.id === "backups" ? BackupsSection : IntegrationSection;
        return (
          <Section
            key={integration.id}
            integration={integration}
            models={models}
            first={index === 0}
          />
        );
      })}
    </div>
  );
}
