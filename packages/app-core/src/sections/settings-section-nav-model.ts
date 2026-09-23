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
  order: number;
}>;

/**
 * The categories the core Settings page always has. `connections` is not
 * one: the connectors capability registers it as a `settings-category`
 * contribution, and the tab exists only while that capability is in the plan.
 */
export const settingsTabs: readonly SettingsTab[] = [
  { id: "general", label: "General", guideId: "settings.general", order: 0 },
  {
    id: "security",
    label: "Security",
    guideId: "settings.security",
    order: 100,
  },
  { id: "vaults", label: "Vaults", guideId: "settings.vaults", order: 200 },
  {
    id: "capabilities",
    label: "Capabilities",
    guideId: "settings.capabilities",
    order: 400,
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
      order: entry.order,
    }));
  return [...settingsTabs, ...contributed].sort((left, right) =>
    left.order !== right.order
      ? left.order - right.order
      : left.id.localeCompare(right.id),
  );
}

export function settingsTabsSnapshot(): readonly SettingsTab[] {
  return settingsTabsFrom(contributionsSnapshot("settings-category"));
}

export type CategoryId = SettingsCategory;

export function categoryFromHash(hash: string): CategoryId | null {
  return settingsCategoryFromHash(hash);
}
