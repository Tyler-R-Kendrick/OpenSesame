import { type ComponentType, useMemo } from "react";
import { Link } from "react-router";
import { useStripItem } from "../lib/strip.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { InstallPanel as DefaultInstallPanel } from "./settings/InstallPanel.js";
import { UnlockMethodsPanel as DefaultUnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
import { VaultsPanel as DefaultVaultsPanel } from "./settings/VaultsPanel.js";

import {
  type SettingsTab,
  settingsTabsFrom,
} from "@opensesame/app-core/sections/settings-section-nav-model.js";
import { useContributions } from "../bindings/contributions.js";
import { useFinePointer } from "../lib/use-narrow.js";

/** The tabs the page draws: no Keybindings where there is no key to press. */
export function useSettingsTabs(): readonly SettingsTab[] {
  const contributions = useContributions("settings-category");
  const keys = useFinePointer();
  return useMemo(
    () =>
      settingsTabsFrom(contributions).filter(
        (tab) => keys || tab.id !== "keybindings",
      ),
    [contributions, keys],
  );
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
  // Capabilities sits far enough along the strip that at 320px it opened
  // partly off the right edge; the strip scrolls itself, never the page.
  const stripRef = useStripItem<HTMLAnchorElement>(current, guideRef);
  return (
    <Link
      ref={stripRef}
      to={to}
      className={`set__nav-link${danger ? " set__nav-link--danger" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

export type SettingsPanels = {
  UnlockMethodsPanel: ComponentType;
  InstallPanel: ComponentType;
  VaultsPanel: ComponentType;
};

export const defaultPanels: SettingsPanels = {
  UnlockMethodsPanel: DefaultUnlockMethodsPanel,
  InstallPanel: DefaultInstallPanel,
  VaultsPanel: DefaultVaultsPanel,
};

/** Old Security fragments → current panel ids. */
export const SECURITY_FRAGMENT_REDIRECT = new Map<string, string>([
  ["key-vault", "vault-key-protection"],
  ["key-sop", "vault-key-protection"],
  ["encryption-keys", "vault-key-protection"],
  ["formats", "sops-document"],
  ["formats-interop", "sops-document"],
  ["interoperability", "sops-document"],
  ["sops", "sops-document"],
  ["duress", "duress-profiles"],
]);
