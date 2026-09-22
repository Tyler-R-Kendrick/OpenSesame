import { type ComponentType, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { SettingsCategoryContribution } from "../lib/capabilities/runtime-contract.js";
import {
  contributionsSnapshot,
  useContributions,
} from "../lib/contributions.js";
import {
  type SettingsCategory,
  settingsCategoryFromHash,
} from "../lib/crumbs.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { InstallPanel as DefaultInstallPanel } from "./settings/InstallPanel.js";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./settings/ModelProviderPanel.js";
import { UnlockMethodsPanel as DefaultUnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
import { VaultsPanel as DefaultVaultsPanel } from "./settings/VaultsPanel.js";

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

export function useSettingsTabs(): readonly SettingsTab[] {
  const contributions = useContributions("settings-category");
  return useMemo(() => settingsTabsFrom(contributions), [contributions]);
}

/** One category link, named so a guide can point at it. */
export function CategoryLink({
  guideId,
  to,
  label,
  danger,
  current,
}: {
  guideId: string;
  to: string;
  label: string;
  danger: boolean;
  current: boolean;
}) {
  const guideRef = useGuideTarget<HTMLAnchorElement>(guideId);
  const node = useRef<HTMLAnchorElement | null>(null);
  // A strip must never hide its own selected item (DESIGN.md § Touch). The
  // strip scrolls sideways once it outgrows the screen, and Capabilities
  // sits far enough along that at 320px it opened partly off the right
  // edge. Bringing the current one into view costs nothing when it is
  // already there, and never scrolls the page: `block: "nearest"`.
  useEffect(() => {
    if (current)
      node.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  return (
    <Link
      ref={(element) => {
        node.current = element;
        guideRef(element);
      }}
      to={to}
      className={`set__nav-link${danger ? " set__nav-link--danger" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

export type CategoryId = SettingsCategory;

export type SettingsPanels = {
  UnlockMethodsPanel: ComponentType;
  InstallPanel: ComponentType;
  ModelProviderPanel: ComponentType;
  VaultsPanel: ComponentType;
};

export const defaultPanels: SettingsPanels = {
  UnlockMethodsPanel: DefaultUnlockMethodsPanel,
  InstallPanel: DefaultInstallPanel,
  ModelProviderPanel: DefaultModelProviderPanel,
  VaultsPanel: DefaultVaultsPanel,
};

export function categoryFromHash(hash: string): CategoryId | null {
  return settingsCategoryFromHash(hash);
}

/** Old Security fragments → current panel ids. */
export const SECURITY_FRAGMENT_REDIRECT = new Map<string, string>([
  ["key-vault", "vault-key-protection"],
  ["key-sop", "vault-key-protection"],
  ["encryption-keys", "vault-key-protection"],
  ["formats", "formats-interoperability"],
  ["formats-interop", "formats-interoperability"],
  ["interoperability", "formats-interoperability"],
  ["duress", "duress-profiles"],
]);
