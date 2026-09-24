import { Suspense, lazy, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  settingsCategoryFromLocation,
  settingsPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { resolveDuressMode } from "@opensesame/app-core/lib/duress/feature/mode.js";
import { categoryFromHash } from "@opensesame/app-core/sections/settings-section-nav-model.js";
import { DuressEnrollmentPanel } from "../routes/settings/security/index.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";
import { SettingsMasterPasswordPanel } from "./SettingsMasterPasswordPanel.js";
import {
  CategoryLink,
  SECURITY_FRAGMENT_REDIRECT,
  type SettingsPanels,
  defaultPanels,
  useSettingsTabs,
} from "./SettingsSectionNav.js";
import { AgeKeysPanel } from "./settings/AgeKeysPanel.js";
import { CapabilitiesPanel } from "./settings/CapabilitiesPanel.js";
import { FormatsInteroperabilityPanel } from "./settings/FormatsInteroperabilityPanel.js";
import { GeneralPrefsPanel } from "./settings/GeneralPrefsPanel.js";
import { VaultsAndTypes } from "./settings/ItemTypesPanel.js";
import { KeybindingsViewsPanel } from "./settings/KeybindingsViewsPanel.js";
import { VaultKeyProtectionPanel } from "./settings/VaultKeyProtectionPanel.js";
import { SettingsFiles } from "./settings/files/SettingsFiles.js";
import { SettingsFileContext } from "./settings/files/context.js";
import { useSettingsFileNav } from "./settings/files/useSettingsFileNav.js";
import "./settings.css";

import { useContributions } from "../bindings/contributions.js";
/** Its own chunk: Transport is read on a Security visit, never on boot. */
const TransportPanel = lazy(() =>
  import("./settings/transport/TransportPanel.js").then((module) => ({
    default: module.TransportPanel,
  })),
);

export type { SettingsPanels } from "./SettingsSectionNav.js";

/**
 * An old `#fragment` link lands on its category's path, a retired Security
 * fragment on its new home, and a live one scrolls into view.
 */
function useSettingsLocation(category: string, hash: string, pathname: string) {
  const navigate = useNavigate();
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
}

export function SettingsSection({
  panels = defaultPanels,
}: {
  panels?: Partial<SettingsPanels>;
} = {}) {
  const resolvedPanels = { ...defaultPanels, ...panels };
  const { hash, pathname, search } = useLocation();
  const tabs = useSettingsTabs();
  const category = settingsCategoryFromLocation(pathname, hash);
  const ContributedPanel = tabs.find((tab) => tab.id === category)?.Panel;
  // Panels a capability draws inside a category the core already has, so
  // Security can carry the ambient opt-in without this file importing it.
  const contributedPanels = [...useContributions("settings-panel")]
    .filter((panel) => panel.category === category)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // A directory's files are the same page spelled as files: its
  // `config.yaml` and whatever else it keeps, opened by `?file=` (the rail,
  // the command bar, a row's open key) and drawn here in place of the form.
  const { openPath, setOpenPath, fileNav } = useSettingsFileNav(
    category,
    search,
  );

  useSettingsLocation(category, hash, pathname);

  const form = openPath === null;

  return (
    <SettingsFileContext.Provider value={fileNav}>
      <div className="section__inner">
        <div className="section__head">
          <h1>Settings</h1>
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
        {form ? null : (
          <SettingsFiles
            category={category}
            selected={openPath}
            onSelect={setOpenPath}
          />
        )}
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

        {form && category === "security" ? (
          <SecurityPanels
            UnlockMethodsPanel={resolvedPanels.UnlockMethodsPanel}
          />
        ) : null}

        {form && category === "vaults" && (
          <VaultsAndTypes {...resolvedPanels} />
        )}
        {form
          ? contributedPanels.map(({ id, Panel }) => <Panel key={id} />)
          : null}
        {form && category === "capabilities" ? <CapabilitiesPanel /> : null}
        {form && category === "danger" ? <SettingsDangerPanel /> : null}
      </div>
    </SettingsFileContext.Provider>
  );
}

/** The Security category's own panels, in the order the screen draws them. */
function SecurityPanels({
  UnlockMethodsPanel,
}: {
  UnlockMethodsPanel: SettingsPanels["UnlockMethodsPanel"];
}) {
  return (
    <>
      <VaultKeyProtectionPanel />
      {resolveDuressMode({}) !== "off" ? <DuressEnrollmentPanel /> : null}
      <UnlockMethodsPanel />
      <FormatsInteroperabilityPanel />
      <AgeKeysPanel />
      <Suspense fallback={null}>
        <TransportPanel />
      </Suspense>
      <SettingsMasterPasswordPanel />
    </>
  );
}
