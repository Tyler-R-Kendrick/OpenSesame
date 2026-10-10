import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { settingsPath } from "@opensesame/app-core/lib/crumbs.js";
import {
  type SettingsTab,
  settingsTabsSnapshot,
} from "@opensesame/app-core/sections/settings-section-nav-model.js";
import {
  SETTINGS_CONFIG_FILE,
  settingsConfigRoute,
} from "@opensesame/app-core/sections/settings/settings-files.js";
import { type PageTreeSource, pageTabTree } from "../../lib/page-to-tree.js";

/** Live lists a Settings tab may mirror (Vaults on this device). */
export type SettingsRailSnapshot = {
  vaults?: readonly { id: string; label: string }[];
  /** List each directory's `config.yaml` (the rail's "show hidden items"). */
  showHidden?: boolean;
  /** The rail's current path: a hidden file is drawn while you stand in it. */
  current?: string;
  /** General › Install draws (InstallPanel's own rule); unlisted when not. */
  install?: boolean;
  /**
   * Capabilities › Guests draws (GuestSection's rule: the operator's switch,
   * never shown to a guest); unlisted when not. Defaults to listed.
   */
  guests?: boolean;
  /**
   * Capabilities › Instance policy draws (the operator's section,
   * `useDeviceOperator`); unlisted when not. Defaults to unlisted.
   */
  instancePolicy?: boolean;
  /**
   * The panels capabilities contribute to core tabs (`settings-panel`), as
   * `SettingsSection` draws them: a tab lists exactly the active ones.
   */
  contributed?: readonly ContributedPanel[];
  /** Security › Duress draws (the owner of an open vault; never a guest or a decoy). */
  duress?: boolean;
  /** Security › Your account draws (an Identity session is held). */
  account?: boolean;
  /**
   * Capabilities sections that draw nothing on this device (no switch, no
   * connector with anything to do): unlisted, as the page leaves them out.
   */
  emptyFeatures?: readonly string[];
};

export type ContributedPanel = Readonly<{
  id: string;
  label: string;
  category: string;
  order: number;
}>;

function panel(category: string, id: string, label: string): PageTreeSource {
  return {
    id,
    label,
    href: settingsPath(category, id),
    keepEmpty: true,
  };
}

/**
 * Sections on Settings → Capabilities, in document order: Guests, every
 * feature section, then the operator's Instance policy. Providers are
 * configured in place. There is no Endpoints panel — Host/Identity/daemon
 * are not Pages backends (ADR 0090; Tyler 2026-10-08).
 */
export function capabilitiesSettingsSections(
  guests = true,
  instancePolicy = false,
  emptyFeatures: readonly string[] = [],
): PageTreeSource[] {
  return [
    ...(guests ? [panel("capabilities", "feature-guests", "Guests")] : []),
    ...FEATURES.filter((feature) => !emptyFeatures.includes(feature.id)).map(
      (feature) =>
        panel("capabilities", `feature-${feature.id}`, feature.title),
    ),
    ...(instancePolicy
      ? [panel("capabilities", "instance-policy", "Instance policy")]
      : []),
  ];
}

/** A category's contributed panels, in the order `SettingsSection` draws them. */
function contributedTo(
  category: string,
  snapshot: SettingsRailSnapshot,
): PageTreeSource[] {
  return (snapshot.contributed ?? [])
    .filter((entry) => entry.category === category)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((entry) => panel(category, entry.id, entry.label));
}

function sectionsFor(
  tab: SettingsTab,
  snapshot: SettingsRailSnapshot,
): PageTreeSource[] {
  const contributed = contributedTo(tab.id, snapshot);
  switch (tab.id) {
    case "general":
      return [
        ...(snapshot.install
          ? [panel("general", "settings-install", "Install")]
          : []),
        panel("general", "settings-appearance", "Appearance"),
        panel("general", "settings-locking", "Locking"),
        ...contributed,
      ];
    case "keybindings":
      return [
        panel("keybindings", "settings-keymap", "Keymap"),
        panel("keybindings", "settings-gestures", "Gestures"),
        panel("keybindings", "settings-macros", "Macros"),
        ...contributed,
      ];
    case "security":
      // SecurityPanels' order: a capability's panels take the slot after
      // the unlock methods and the account's own factors.
      return [
        panel("security", "vault-key-protection", "Vault key protection"),
        panel("security", "unlock-methods", "Unlock methods"),
        panel("security", "second-step", "Second step"),
        panel("security", "recovery", "Recovery"),
        ...(snapshot.account
          ? [panel("security", "account-factors", "Your account")]
          : []),
        ...(snapshot.duress
          ? [
              panel("security", "duress-profiles", "Duress"),
              panel("security", "travel", "Travel"),
            ]
          : []),
        ...contributed,
      ];
    case "vaults":
      return [
        ...(snapshot.vaults ?? []).map((vault) => ({
          id: vault.id,
          label: vault.label,
          href: settingsPath("vaults"),
          keepEmpty: true,
        })),
        panel("vaults", "item-types", "Item types"),
        ...contributed,
      ];
    case "capabilities":
      return [
        ...contributed,
        ...capabilitiesSettingsSections(
          snapshot.guests ?? true,
          snapshot.instancePolicy ?? false,
          snapshot.emptyFeatures ?? [],
        ),
      ];
    case "danger":
      return [
        ...contributed,
        panel("danger", "settings-delete-vault", "Delete this vault"),
        panel("danger", "settings-trash", "Trash"),
      ];
    default:
      // A contributed tab: the panels its module says it always draws.
      return [
        ...(tab.panels ?? []).map((entry) =>
          panel(tab.id, entry.id, entry.label),
        ),
        ...contributed,
      ];
  }
}

/**
 * Settings page: each tab is a subtree of the panels/headings that tab shows.
 * The rail must not keep a second hardcoded hierarchy. Every tab lists its
 * panels, so every tab is the same kind of row: one left with nothing under
 * it drew without a caret, one indent left of its siblings.
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
    sections: sectionsFor(tab, snapshot),
    items:
      snapshot.showHidden || snapshot.current === settingsConfigRoute(tab.id)
        ? [
            {
              id: `${tab.id}-config`,
              label: SETTINGS_CONFIG_FILE,
              href: settingsConfigRoute(tab.id),
              hidden: true,
              first: true,
              kind: "file",
            },
          ]
        : undefined,
  }));
}

export function settingsPageTree(snapshot: SettingsRailSnapshot = {}) {
  return pageTabTree(settingsPageSources(snapshot));
}
