/**
 * View-model logic for `SettingsSectionNav` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { ComponentType } from "react";
import type { SettingsCategoryContribution } from "../lib/capabilities/runtime-contract.js";
import { contributionsSnapshot } from "../lib/contributions.js";
import {
  type SettingsCategory,
  settingsCategoryFromHash,
} from "../lib/crumbs.js";

export type SettingsTab = Readonly<{
  id: string;
  label: string;
  guideId: string;
  /** Present on a contributed category: the panel its module supplied. */
  Panel?: ComponentType;
  /** A contributed category's always-drawn panels, for the rail. */
  panels?: SettingsCategoryContribution["panels"];
  order: number;
}>;

/**
 * The categories the core Settings page always has. A capability may add a
 * tab of its own as a `settings-category` contribution (Live sessions,
 * Trusted contacts, Notification routing); it exists only while that
 * capability is in the plan.
 */
export const settingsTabs: readonly SettingsTab[] = [
  { id: "general", label: "General", guideId: "settings.general", order: 0 },
  {
    id: "keybindings",
    label: "Keybindings",
    guideId: "settings.keybindings",
    order: 50,
  },
  {
    id: "security",
    label: "Security",
    guideId: "settings.security",
    order: 100,
  },
  { id: "vaults", label: "Vaults", guideId: "settings.vaults", order: 200 },
  {
    id: "item-types",
    label: "Item types",
    guideId: "settings.item-types",
    order: 350,
  },
  {
    id: "features",
    label: "Features",
    guideId: "settings.features",
    order: 400,
  },
  {
    id: "integrations",
    label: "Integrations",
    guideId: "settings.integrations",
    order: 450,
  },
  { id: "danger", label: "Danger", guideId: "settings.danger", order: 1000 },
];

/** Core tabs plus the registered `settings-category` contributions, in order. */
export function settingsTabsFrom(
  contributions: readonly SettingsCategoryContribution[],
): readonly SettingsTab[] {
  const contributed = contributions
    .filter((entry) => !settingsTabs.some((tab) => tab.id === entry.id))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      guideId: entry.guideId,
      Panel: entry.Panel,
      panels: entry.panels,
      order: entry.order,
    }));
  return [...settingsTabs, ...contributed].sort((left, right) =>
    left.order !== right.order
      ? left.order - right.order
      : left.id.localeCompare(right.id),
  );
}

/** The two settings destinations: one belongs to the vault, one to the person. */
export const SETTINGS_GROUPS = [
  {
    id: "vault",
    label: "Vault Settings",
    initialCategory: "general",
  },
  {
    id: "user",
    label: "User Settings",
    initialCategory: "keybindings",
  },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

const USER_SETTINGS_CATEGORIES = new Set<string>(["keybindings", "vaults"]);

/** A category belongs to User Settings only when it is the person's own. */
export function settingsGroupForCategory(category: string): SettingsGroup {
  return SETTINGS_GROUPS[USER_SETTINGS_CATEGORIES.has(category) ? 1 : 0];
}

/** The categories one group draws, in tab order. */
export function settingsTabsForGroup(
  tabs: readonly SettingsTab[],
  group: SettingsGroupId,
): readonly SettingsTab[] {
  return tabs.filter((tab) => settingsGroupForCategory(tab.id).id === group);
}

export function settingsTabsSnapshot(): readonly SettingsTab[] {
  return settingsTabsFrom(contributionsSnapshot("settings-category"));
}

export type CategoryId = SettingsCategory;

export function categoryFromHash(hash: string): CategoryId | null {
  return settingsCategoryFromHash(hash);
}
