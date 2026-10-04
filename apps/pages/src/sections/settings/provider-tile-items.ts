/**
 * Which connector tiles a Capabilities section draws on this device, and so
 * whether the section draws at all. The page, the rail and the phone's page
 * index all ask here, so none lists a section or a tile the page leaves out
 * (ADR 0158: a row acts, or it is not drawn).
 */

import {
  type Feature,
  type SurfaceContext,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/catalog-provider.js";
import type { TileRoad } from "@opensesame/app-core/lib/connect-roads.js";
import type {
  Provider,
  ProviderCategory,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { HISTORY_BACKUP_GROUPS } from "@opensesame/app-core/lib/history-backups.js";
import { isManagedConnector } from "@opensesame/app-core/lib/managed-connectors.js";
import {
  connectorPath,
  isFeatureBindingCategory,
} from "@opensesame/app-core/sections/connections/shared.js";
import type { EffectivePlan } from "@opensesame/capability-composition";

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

/**
 * `href` is the connector's page, or null where only the tile's own enable
 * switch acts (`TileRoad`): a tile never links to a page nothing routes.
 */
export type ProviderTileItem = { provider: Provider; href: string | null };

/** One category's catalog brokers, skipping managed Connect ids. */
function bindingItems(
  providers: readonly Provider[],
): Map<ProviderCategory, Provider[]> {
  const grouped = new Map<ProviderCategory, Provider[]>();
  for (const provider of providers) {
    if (!isConnectionCatalogProvider(provider)) continue;
    if (isManagedConnector(provider.id)) continue;
    if (!isFeatureBindingCategory(provider.category)) continue;
    const items = grouped.get(provider.category) ?? [];
    items.push(provider);
    grouped.set(provider.category, items);
  }
  return grouped;
}

/**
 * One category's tiles, in catalog order, keeping the connectors a tile has
 * something to offer for on this device (`tile`): a link to a page that has
 * something to do, or a switch that acts without one. Never a row that leads
 * to a dead end.
 */
export function providerTileItems(
  category: ProviderCategory,
  tile: (provider: Provider) => TileRoad | null,
): ProviderTileItem[] {
  const providers = getBundledProviders().map(placed);
  const items: ProviderTileItem[] = [];
  for (const provider of bindingItems(providers).get(category) ?? []) {
    const road = tile(provider);
    if (road === null) continue;
    items.push({
      provider,
      href:
        road === "page"
          ? connectorPath(provider.id, undefined, "/settings/connections")
          : null,
    });
  }
  return items;
}

/**
 * Does the section draw anything? A switch, or a tile. A subheader over
 * nothing is not drawn — the way a group with nothing in it is absent.
 */
export function featureDraws(
  feature: Feature,
  tile: (provider: Provider) => TileRoad | null,
  plan: EffectivePlan | null = null,
  context?: SurfaceContext,
): boolean {
  return (
    isSwitchable(feature, plan, context) ||
    feature.providerCategories.some(
      (category) => providerTileItems(category, tile).length > 0,
    )
  );
}
