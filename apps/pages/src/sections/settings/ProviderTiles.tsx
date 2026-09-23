/**
 * The connectors one family binds to, drawn as tiles — the rows Settings ›
 * Connections used to carry, now drawn under the feature (or the always-on
 * group) that uses them on Settings › Capabilities. Each tile opens its
 * connector page (`/settings/connections/<provider>`), and a backup road
 * wears its enable switch.
 */

import type { ProviderCategory } from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { useSettingsEpoch } from "../../lib/use-settings.js";
import { featureBindingSections } from "../connections/page-tree.js";
import "../connections.css";
import {
  FeatureBindingTile,
  hostTargetProviderId,
  useHostBackupTarget,
} from "./FeatureBindingTile.js";

export function ProviderTiles({
  category,
  label,
}: {
  category: ProviderCategory;
  /** Names the list for assistive technology. */
  label: string;
}) {
  const providers = getBundledProviders();
  const group = featureBindingSections(providers).find(
    (section) => section.id === category,
  );
  const target = useHostBackupTarget();
  useSettingsEpoch();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const hostProviderId = hostTargetProviderId(target);
  const items = group?.items ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="conn-grid" id={category} aria-label={label}>
      {items.map((item) => {
        const provider = byId.get(item.id);
        if (!provider) return null;
        return (
          <FeatureBindingTile
            key={item.id}
            provider={provider}
            href={item.href}
            hostTarget={hostProviderId === provider.id ? target : null}
          />
        );
      })}
    </ul>
  );
}
