import { settingsPath } from "../../lib/crumbs.js";
import type { PageTreeSource } from "../../lib/page-to-tree.js";
import { pageToTree } from "../../lib/page-to-tree.js";
import { settingsTabs } from "../SettingsSection.js";

/** The same tabs the settings page renders. The rail does not keep a second list. */
export function settingsPageSources(): PageTreeSource[] {
  return [
    {
      id: "settings",
      label: "Settings",
      href: settingsPath("general"),
      items: settingsTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        href: settingsPath(tab.id),
      })),
    },
  ];
}

export function settingsPageTree() {
  return pageToTree(settingsPageSources());
}
