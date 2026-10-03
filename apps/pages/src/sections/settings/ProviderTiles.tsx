/**
 * The connectors one family binds to, drawn as tiles — the rows Settings ›
 * Connections used to carry, now drawn under the feature (or the always-on
 * group) that uses them on Settings › Capabilities. Each tile opens its
 * connector page (`/settings/connections/<provider>`) while Connections is on,
 * and a backup road wears its enable switch. A connector with nothing to do
 * on this device draws no tile, and a tile never links to a page that is not
 * routed (`providerTileItems`).
 */

import type { ProviderCategory } from "@opensesame/app-core/lib/connections.js";
import { useConnectorRoads } from "../../bindings/connector-roads.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import "../connections.css";
import {
  FeatureBindingTile,
  backupTargetProvider,
  useBackupTarget,
} from "./FeatureBindingTile.js";
import { providerTileItems } from "./provider-tile-items.js";

export function ProviderTiles({
  category,
  label,
}: {
  category: ProviderCategory;
  /** Names the list for assistive technology. */
  label: string;
}) {
  const target = useBackupTarget(category === "backup_recovery");
  const roads = useConnectorRoads();
  useSettingsEpoch();
  const targetProviderId = backupTargetProvider(target);
  const items = providerTileItems(category, roads.tile);
  if (items.length === 0) return null;
  return (
    <ul className="conn-grid" id={category} aria-label={label}>
      {items.map(({ provider, href }) => (
        <FeatureBindingTile
          key={provider.id}
          provider={provider}
          href={href}
          target={targetProviderId === provider.id ? target : null}
        />
      ))}
    </ul>
  );
}
