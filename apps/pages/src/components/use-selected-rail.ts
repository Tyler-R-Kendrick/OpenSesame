import { uniqueFolderKind } from "@opensesame/app-core/components/vault-rail-model.js";
import {
  isSettingsConfigSearch,
  settingsCategoryFromLocation,
  settingsConfigRoute,
} from "@opensesame/app-core/lib/crumbs.js";
import type { ItemKindRow } from "@opensesame/app-core/lib/item-kinds.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useLocation, useSearchParams } from "react-router";
import { treeCurrent } from "../lib/vault-list-path.js";
import { selectedRailPath } from "./rail-path.js";

/**
 * The rail entry the page is on. A settings directory's `config.yaml` is its
 * own entry; on a phone the bare vault is the tree itself, so its "all items"
 * entry has an address of its own and the cursor stands on that.
 */
export function useSelectedRail(
  items: VaultItem[],
  kinds: readonly ItemKindRow[],
  allTo: string,
): string {
  const location = useLocation();
  const [params] = useSearchParams();
  const folder = params.get("folder");
  const category = settingsCategoryFromLocation(
    location.pathname,
    location.hash,
  );
  const selected =
    location.pathname.startsWith("/settings") &&
    isSettingsConfigSearch(location.search)
      ? settingsConfigRoute(category)
      : selectedRailPath(
          location.pathname,
          location.hash,
          params.get("view"),
          params.get("f") ?? "all",
          folder,
          category,
          folder ? uniqueFolderKind(items, folder, kinds) : null,
        );
  return treeCurrent(selected, allTo);
}
