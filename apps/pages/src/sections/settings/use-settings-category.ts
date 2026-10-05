import {
  type SettingsCategory,
  settingsCategoryFromLocation,
} from "@opensesame/app-core/lib/crumbs.js";
import { useLocation } from "react-router";

/**
 * The category a settings address draws. Keybindings is drawn on every device
 * (ADR 0166): a phone's has a Gestures tab, and keys still work on a phone
 * with a keyboard attached.
 */
export function useSettingsCategory(): SettingsCategory {
  const { pathname, hash } = useLocation();
  return settingsCategoryFromLocation(pathname, hash);
}
