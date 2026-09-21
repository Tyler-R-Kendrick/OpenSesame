import { type SettingsCategory, settingsPath } from "../../lib/crumbs.js";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { type PageTreeSource, pageTabTree } from "../../lib/page-to-tree.js";
import { settingsTabs } from "../SettingsSection.js";
import { featureBindingSections } from "../connections/page-tree.js";

/** Live lists a Settings tab may mirror (Vaults on this device). */
export type SettingsRailSnapshot = {
  vaults?: readonly { id: string; label: string }[];
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
  category: SettingsCategory,
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
    case "danger":
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
  return settingsTabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: settingsPath(tab.id),
    keepEmpty: true,
    sections: sectionsFor(tab.id, snapshot),
  }));
}

export function settingsPageTree(snapshot: SettingsRailSnapshot = {}) {
  return pageTabTree(settingsPageSources(snapshot));
}
