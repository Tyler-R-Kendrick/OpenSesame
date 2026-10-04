import {
  type SettingsCategory,
  settingsCategoryFromLocation,
} from "@opensesame/app-core/lib/crumbs.js";
import { useLocation } from "react-router";
import { useFinePointer } from "../../lib/use-narrow.js";

/**
 * The category a settings address draws. Keybindings is General where no
 * fine pointer is attached: the page, the tab strip and the rail's cursor all
 * read this, so the key editor never renders for a frame before the address
 * is rewritten.
 */
export function effectiveSettingsCategory(
  pathname: string,
  hash: string,
  keys: boolean,
): SettingsCategory {
  const category = settingsCategoryFromLocation(pathname, hash);
  return !keys && category === "keybindings" ? "general" : category;
}

export function useSettingsCategory(): SettingsCategory {
  const { pathname, hash } = useLocation();
  return effectiveSettingsCategory(pathname, hash, useFinePointer());
}
