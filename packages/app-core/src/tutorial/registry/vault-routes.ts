/**
 * Where a tour's `navigate` goes when the route names a place, not a path.
 *
 * `/vault/item` is the pane of an item and `/vault/trash` the list of what was
 * trashed; neither is an address a program could spell, because an item's
 * address holds its id and the trash is a filter. The tour names the place and
 * this resolves it, reading the vault only for the id of the first item that is
 * not in the trash — never a name, a field or a value.
 */

import { sortItems } from "@opensesame/vault-core";
import { vaultStore } from "../../lib/vault/store.js";
import { type GuideRouteId, guideRouteForLocation } from "./routes.js";

export const VAULT_ITEM_ROUTE = "/vault/item";
export const VAULT_TRASH_ROUTE = "/vault/trash";

/**
 * The address to go to for `route`, or `null` when nothing should move: the
 * person is already in that place, or there is no item to open. `here` is the
 * router's own location, so a deployment under a base path reads the same.
 */
export function guideNavigationPath(
  route: GuideRouteId,
  here: { readonly pathname: string; readonly search: string },
): string | null {
  if (route !== VAULT_ITEM_ROUTE && route !== VAULT_TRASH_ROUTE) return route;
  if (guideRouteForLocation(here.pathname, here.search) === route) return null;
  if (route === VAULT_TRASH_ROUTE) return "/vault?f=trash";
  const [first] = sortItems(
    vaultStore.getSnapshot().items.filter((item) => item.deletedAt === null),
  );
  return first ? `/vault/${first.id}` : null;
}
