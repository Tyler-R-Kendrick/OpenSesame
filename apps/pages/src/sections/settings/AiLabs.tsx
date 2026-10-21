/**
 * Settings › Integrations › AI — the labs a person may bring a key for.
 *
 * The catalog decides which rows a browser can actually configure. The rest
 * of the main labs still belong in the list: a person looking for their
 * provider should find its name here, even where this build has no connector
 * page for it yet. A supported row links to its page once Connections routes
 * it; an unsupported row is the same tile without a link.
 */

import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { INTEGRATION_AI_LABS } from "@opensesame/app-core/lib/integration-ai-labs.js";
import { connectorPath } from "@opensesame/app-core/sections/connections/shared.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { FeatureBindingTile } from "./FeatureBindingTile.js";

/** Kept as the page-local name used by the settings tests and callers. */
export const AI_LABS = INTEGRATION_AI_LABS;

function LabTile({ id, name }: { id: string; name: string }) {
  return (
    <li className="conn-tile">
      <div className="conn-tile__row">
        <span className="conn-tile__face">
          <ConnectorMark providerId={id} displayName={name} size={32} />
          <span className="conn-tile__copy">
            <span className="conn-tile__name">{name}</span>
          </span>
        </span>
      </div>
    </li>
  );
}

export function AiLabs() {
  const roads = useConnectorRoads();
  const providers = new Map(
    getBundledProviders().map((provider) => [provider.id, provider]),
  );
  return (
    <ul className="conn-grid" id="ai_model_provider" aria-label="AI providers">
      {AI_LABS.map((lab) => {
        const provider = providers.get(lab.id);
        const road = provider ? roads.tile(provider) : null;
        if (provider && road === "page") {
          return (
            <FeatureBindingTile
              key={lab.id}
              provider={{ ...provider, displayName: lab.name }}
              href={connectorPath(
                provider.id,
                undefined,
                "/settings/connections",
              )}
              target={null}
            />
          );
        }
        return <LabTile key={lab.id} id={lab.id} name={lab.name} />;
      })}
    </ul>
  );
}
