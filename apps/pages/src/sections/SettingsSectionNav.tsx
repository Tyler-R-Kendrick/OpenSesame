import type { ComponentType } from "react";
import { Link } from "react-router";
import {
  type SettingsCategory,
  settingsCategoryFromHash,
} from "../lib/crumbs.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { InstallPanel as DefaultInstallPanel } from "./settings/InstallPanel.js";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./settings/ModelProviderPanel.js";
import { UnlockMethodsPanel as DefaultUnlockMethodsPanel } from "./settings/UnlockMethodsPanel.js";
import { VaultsPanel as DefaultVaultsPanel } from "./settings/VaultsPanel.js";

export const settingsTabs = [
  { id: "general", label: "General", guideId: "settings.general" },
  { id: "security", label: "Security", guideId: "settings.security" },
  { id: "vaults", label: "Vaults", guideId: "settings.vaults" },
  {
    id: "connections",
    label: "Connections",
    guideId: "settings.connections",
  },
  { id: "danger", label: "Danger", guideId: "settings.danger" },
] as const satisfies readonly {
  id: SettingsCategory;
  label: string;
  guideId: string;
}[];

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
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return (
    <Link
      ref={ref}
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
