/**
 * The connectors one family binds to, drawn as tiles — the rows Settings ›
 * Connections used to carry, now drawn under the feature (or the always-on
 * group) that uses them on Settings › Capabilities. Each tile opens its
 * connector page (`/settings/connections/<provider>`), and a backup road
 * wears its enable switch. A connector whose page has nothing to do on this
 * device draws no tile (`providerTileItems`).
 */

import type { ProviderCategory } from "@opensesame/app-core/lib/connections.js";
import { useConnectorTiles } from "../../bindings/connector-roads.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import "../connections.css";
import {
  FeatureBindingTile,
  hostTargetProviderId,
  useHostBackupTarget,
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
  const target = useHostBackupTarget(category === "backup_recovery");
  const tileActs = useConnectorTiles();
  useSettingsEpoch();
  const hostProviderId = hostTargetProviderId(target);
  const items = providerTileItems(category, tileActs);
  if (items.length === 0) return null;
  return (
    <ul className="conn-grid" id={category} aria-label={label}>
      {items.map(({ provider, href }) => (
        <FeatureBindingTile
          key={provider.id}
          provider={provider}
          href={href}
          hostTarget={hostProviderId === provider.id ? target : null}
        />
      ))}
    </ul>
  );
}
