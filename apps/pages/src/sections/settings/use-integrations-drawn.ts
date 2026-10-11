import {
  INTEGRATIONS,
  type Integration,
} from "@opensesame/app-core/lib/capabilities/integrations.js";
import { useComposition } from "../../bindings/capabilities.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { useContributions } from "../../bindings/contributions.js";
import { integrationDraws, modelPicksDrawn } from "./provider-tile-items.js";

/** `support.local-ai`'s model picker, drawn in the AI integration once AI is on. */
export const MODEL_PROVIDER_PANEL = "model-provider";

export type DrawnIntegration = Readonly<{
  integration: Integration;
  /** The model picks draw in this section. */
  models: boolean;
}>;

/**
 * The integrations that draw on this device, by the rule the page draws them
 * by. The page, the rail, the phone's page index and the tutorial gate all
 * start here, so none lists a section the page leaves out.
 */
export function useIntegrationsDrawn(): readonly DrawnIntegration[] {
  const { plan } = useComposition();
  const roads = useConnectorRoads();
  const panels = useContributions("settings-panel");
  const panelPresent = panels.some(
    (panel) => panel.id === MODEL_PROVIDER_PANEL,
  );
  return INTEGRATIONS.map((integration) => ({
    integration,
    models: modelPicksDrawn(integration, plan, panelPresent),
  })).filter(({ integration, models }) =>
    integrationDraws(integration, roads.tile, models),
  );
}
