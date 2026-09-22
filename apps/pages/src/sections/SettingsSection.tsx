import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { settingsCategoryFromLocation, settingsPath } from "../lib/crumbs.js";
import { resolveDuressMode } from "../lib/duress/feature/mode.js";
import { DuressEnrollmentPanel } from "../routes/settings/security/index.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";
import { SettingsMasterPasswordPanel } from "./SettingsMasterPasswordPanel.js";
import {
  CategoryLink,
  SECURITY_FRAGMENT_REDIRECT,
  type SettingsPanels,
  categoryFromHash,
  defaultPanels,
  settingsTabs,
} from "./SettingsSectionNav.js";
import { AgeKeysPanel } from "./settings/AgeKeysPanel.js";
import { FeatureBindingsPanel } from "./settings/FeatureBindingsPanel.js";
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
  const category = settingsCategoryFromLocation(pathname, hash);
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
        {settingsTabs.map((entry) => (
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
      {form && category === "connections" ? (
        <FeatureBindingsPanel
          ModelProviderPanel={resolvedPanels.ModelProviderPanel}
        />
      ) : null}
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
      {form && category === "security" && resolveDuressMode({}) !== "off" ? (
        <DuressEnrollmentPanel />
      ) : null}
      {form && category === "security" ? (
        <resolvedPanels.UnlockMethodsPanel />
      ) : null}
      {form && category === "security" ? (
        <FormatsInteroperabilityPanel />
      ) : null}
      {form && category === "security" ? <AgeKeysPanel /> : null}
      {form && category === "security" ? <SettingsMasterPasswordPanel /> : null}

      {form && category === "vaults" ? <resolvedPanels.VaultsPanel /> : null}
      {form && category === "danger" ? <SettingsDangerPanel /> : null}
    </div>
  );
}
