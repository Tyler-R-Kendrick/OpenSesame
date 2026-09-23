import {
  type SettingsCategory,
  settingsPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { settingsTabsSnapshot } from "@opensesame/app-core/sections/settings-section-nav-model.js";
import {
  SETTINGS_CONFIG_FILE,
  settingsConfigRoute,
} from "@opensesame/app-core/sections/settings/settings-files.js";
import { type PageTreeSource, pageTabTree } from "../../lib/page-to-tree.js";
import { featureBindingSections } from "../connections/page-tree.js";

/** Live lists a Settings tab may mirror (Vaults on this device). */
export type SettingsRailSnapshot = {
  vaults?: readonly { id: string; label: string }[];
  /** List each directory's `config.yaml` (the rail's "show hidden items"). */
  showHidden?: boolean;
  /** The rail's current path: a hidden file is drawn while you stand in it. */
  current?: string;
};

function panel(
  category: SettingsCategory,
  id: string,
  label: string,
): PageTreeSource {
  return {
    id,
    label,
    href: settingsPath(category, id),
    keepEmpty: true,
  };
}

/**
 * Headings on Settings → Connections (FeatureBindingsPanel), in document
 * order — Models, then capability families.
 */
export function connectionsSettingsSections(): PageTreeSource[] {
  return [
    panel("connections", "model-provider", "Models"),
    ...featureBindingSections(getBundledProviders()),
  ];
}

function sectionsFor(
  category: string,
  snapshot: SettingsRailSnapshot,
): PageTreeSource[] {
  switch (category) {
    case "general":
      return [panel("general", "settings-install", "Install")];
    case "security":
      return [
        panel("security", "vault-key-protection", "Vault key protection"),
        panel("security", "formats-interoperability", "Formats"),
        panel("security", "age-keys", "Age keys"),
        panel("security", "transport", "Transport"),
      ];
    case "vaults":
      return (snapshot.vaults ?? []).map((vault) => ({
        id: vault.id,
        label: vault.label,
        href: settingsPath("vaults"),
        keepEmpty: true,
      }));
    case "connections":
      return connectionsSettingsSections();
    default:
      return [];
  }
}

/**
 * Settings page: each tab is a subtree of the panels/headings that tab shows.
 * The rail must not keep a second hardcoded hierarchy.
 */
export function settingsPageSources(
  snapshot: SettingsRailSnapshot = {},
): PageTreeSource[] {
  return settingsTabsSnapshot().map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: settingsPath(tab.id),
    keepEmpty: true,
    config: settingsConfigRoute(tab.id),
    sections: sectionsFor(tab.id, snapshot),
    items:
      snapshot.showHidden || snapshot.current === settingsConfigRoute(tab.id)
        ? [
            {
              id: `${tab.id}-config`,
              label: SETTINGS_CONFIG_FILE,
              href: settingsConfigRoute(tab.id),
              hidden: true,
              kind: "file",
            },
          ]
        : undefined,
  }));
}

export function settingsPageTree(snapshot: SettingsRailSnapshot = {}) {
  return pageTabTree(settingsPageSources(snapshot));
}
