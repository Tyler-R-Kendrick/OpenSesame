import { PREFS_DISPLAY_PATH } from "../../lib/configuration/aliases.js";
import { pinnedViewsForScope } from "../../lib/configuration/nav-persist.js";
import { settingsPath } from "../../lib/crumbs.js";
import type { PageTreeSource } from "../../lib/page-to-tree.js";
import { pageToTree } from "../../lib/page-to-tree.js";

export function settingsPageSources(): PageTreeSource[] {
  const views = pinnedViewsForScope("local").map((view) => ({
    id: `view-${view.id}`,
    label: `settings/views/${view.id}.yaml`,
    href: settingsPath("general"),
  }));
  return [
    {
      id: "general",
      label: "general",
      href: settingsPath("general"),
      items: [
        {
          id: "prefs.yaml",
          label: PREFS_DISPLAY_PATH,
          href: settingsPath("general"),
        },
        {
          id: "keybindings.yaml",
          label: "settings/keybindings.yaml",
          href: settingsPath("general"),
        },
        ...views,
      ],
    },
  ];
}

export function settingsPageTree() {
  return pageToTree(settingsPageSources());
}
