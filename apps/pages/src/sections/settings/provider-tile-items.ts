/**
 * Which connector tiles a Capabilities section draws on this device, and so
 * whether the section draws at all. The page, the rail and the phone's page
 * index all ask here, so none lists a section or a tile the page leaves out
 * (ADR 0150: a row acts, or it is not drawn).
 */

import {
  type Feature,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type {
  Provider,
  ProviderCategory,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { HISTORY_BACKUP_GROUPS } from "@opensesame/app-core/lib/history-backups.js";
import { featureBindingSections } from "../connections/page-tree.js";

const HISTORY_ROADS = new Set(
  HISTORY_BACKUP_GROUPS.flatMap((group) => group.providerIds),
);

/**
 * A git history road is drawn under Backups whatever its catalog category:
 * the one catalog (ADR 0139) files password-store under local storage, as
 * Fnox does, but here it is configured beside the forges (ADR 0142).
 */
function placed(provider: Provider): Provider {
  return HISTORY_ROADS.has(provider.id)
    ? { ...provider, category: "backup_recovery" }
    : provider;
}

export type ProviderTileItem = { provider: Provider; href: string };

/**
 * One category's tiles, in catalog order, keeping the connectors whose page
 * has something to do on this device (`acts`). A tile is a link to that page:
 * never a row that leads to a dead end.
 */
export function providerTileItems(
  category: ProviderCategory,
  acts: (provider: Provider) => boolean,
): ProviderTileItem[] {
  const providers = getBundledProviders().map(placed);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const group = featureBindingSections(providers).find(
    (section) => section.id === category,
  );
  const items: ProviderTileItem[] = [];
  for (const item of group?.items ?? []) {
    const provider = byId.get(item.id);
    if (provider && acts(provider)) items.push({ provider, href: item.href });
  }
  return items;
}

/**
 * Does the section draw anything? A switch, or a tile. A subheader over
 * nothing is not drawn — the way a group with nothing in it is absent.
 */
export function featureDraws(
  feature: Feature,
  acts: (provider: Provider) => boolean,
): boolean {
  return (
    isSwitchable(feature) ||
    feature.providerCategories.some(
      (category) => providerTileItems(category, acts).length > 0,
    )
  );
}
