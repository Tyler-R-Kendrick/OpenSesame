import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useContributions } from "../lib/contributions.js";
import { settingsCategoryFromLocation, settingsPath } from "../lib/crumbs.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";
import { SettingsMasterPasswordPanel } from "./SettingsMasterPasswordPanel.js";
import {
  CategoryLink,
  SECURITY_FRAGMENT_REDIRECT,
  type SettingsPanels,
  categoryFromHash,
  defaultPanels,
  useSettingsTabs,
} from "./SettingsSectionNav.js";
import { AgeKeysPanel } from "./settings/AgeKeysPanel.js";
import { CapabilitiesPanel } from "./settings/CapabilitiesPanel.js";
import { FormatsInteroperabilityPanel } from "./settings/FormatsInteroperabilityPanel.js";
import { GeneralPrefsPanel } from "./settings/GeneralPrefsPanel.js";
import { KeybindingsViewsPanel } from "./settings/KeybindingsViewsPanel.js";
import { SettingsRawEditor } from "./settings/SettingsRawEditor.js";
import { SettingsViewToggle } from "./settings/SettingsViewToggle.js";
import { VaultKeyProtectionPanel } from "./settings/VaultKeyProtectionPanel.js";
import type { RawFormat } from "./settings/settings-files.js";
import "./settings.css";

export { settingsTabs, type SettingsPanels } from "./SettingsSectionNav.js";

export function SettingsSection({
  panels = defaultPanels,
}: {
  panels?: Partial<SettingsPanels>;
} = {}) {
  const resolvedPanels = { ...defaultPanels, ...panels };
  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const tabs = useSettingsTabs();
  const category = settingsCategoryFromLocation(pathname, hash);
  const ContributedPanel = tabs.find((tab) => tab.id === category)?.Panel;
  // Panels a capability draws inside a category the core already has, so
  // Security can carry the ambient opt-in without this file importing it.
  const contributedPanels = [...useContributions("settings-panel")]
    .filter((panel) => panel.category === category)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const [representation, setRepresentation] = useState<"form" | RawFormat>(
    "form",
  );

  useEffect(() => {
    const fromHash = categoryFromHash(hash);
    if (fromHash && !pathname.match(/\/settings\/[^/]+/)) {
      navigate(settingsPath(fromHash, hash), { replace: true });
    }
  }, [hash, navigate, pathname]);

  useEffect(() => {
    if (category !== "security") return;
    const raw = hash.replace(/^#/, "");
    const redirected = SECURITY_FRAGMENT_REDIRECT.get(raw);
    if (!redirected) return;
    navigate(settingsPath("security", redirected), { replace: true });
  }, [category, hash, navigate]);

  useEffect(() => {
    if (category !== "security") return;
    const id = hash.replace(/^#/, "");
    if (!id || SECURITY_FRAGMENT_REDIRECT.has(id)) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [category, hash]);

  const form = representation === "form";

  return (
    <div className="section__inner">
      <div className="section__head">
        <h1>Settings</h1>
        <SettingsViewToggle
          representation={representation}
          onChange={setRepresentation}
        />
      </div>

      <nav className="set__nav" aria-label="Settings sections">
        {tabs.map((entry) => (
          <CategoryLink
            key={entry.id}
            guideId={entry.guideId}
            to={settingsPath(entry.id)}
            label={entry.label}
            danger={entry.id === "danger"}
            current={category === entry.id}
          />
        ))}
      </nav>
      {representation === "yaml" || representation === "toml" ? (
        <SettingsRawEditor category={category} format={representation} />
      ) : null}
      {form && ContributedPanel ? <ContributedPanel /> : null}
      {form && category === "general" ? (
        <>
          <GuideTarget id="settings.install">
            <resolvedPanels.InstallPanel />
          </GuideTarget>
          <GeneralPrefsPanel />
          <KeybindingsViewsPanel />
        </>
      ) : null}

      {form && category === "security" ? <VaultKeyProtectionPanel /> : null}
      {form && category === "security" ? (
        <resolvedPanels.UnlockMethodsPanel />
      ) : null}
      {form && category === "security" ? (
        <FormatsInteroperabilityPanel />
      ) : null}
      {form && category === "security" ? <AgeKeysPanel /> : null}
      {form && category === "security" ? <SettingsMasterPasswordPanel /> : null}

      {form && category === "vaults" ? <resolvedPanels.VaultsPanel /> : null}
      {form
        ? contributedPanels.map(({ id, Panel }) => <Panel key={id} />)
        : null}
      {form && category === "capabilities" ? <CapabilitiesPanel /> : null}
      {form && category === "danger" ? <SettingsDangerPanel /> : null}
    </div>
  );
}
