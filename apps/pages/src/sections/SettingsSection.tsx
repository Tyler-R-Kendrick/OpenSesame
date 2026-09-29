import { type ComponentType, Suspense, lazy, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { PageIndex } from "../components/PageIndex.js";
import { useHashTarget } from "../lib/hash-target.js";
import { settingsPageSources } from "./settings/page-tree.js";

import {
  settingsCategoryFromLocation,
  settingsPath,
} from "@opensesame/app-core/lib/crumbs.js";
import { categoryFromHash } from "@opensesame/app-core/sections/settings-section-nav-model.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";
import {
  CategoryLink,
  SECURITY_FRAGMENT_REDIRECT,
  type SettingsPanels,
  defaultPanels,
  useSettingsTabs,
} from "./SettingsSectionNav.js";
import { AgeKeysPanel } from "./settings/AgeKeysPanel.js";
import { CapabilitiesPanel } from "./settings/CapabilitiesPanel.js";
import { GeneralPrefsPanel } from "./settings/GeneralPrefsPanel.js";
import { VaultsAndTypes } from "./settings/ItemTypesPanel.js";
import { KeybindingsPanel } from "./settings/KeybindingsPanel.js";
import { VaultKeyProtectionPanel } from "./settings/VaultKeyProtectionPanel.js";
import { SettingsFiles } from "./settings/files/SettingsFiles.js";
import { SettingsFileContext } from "./settings/files/context.js";
import { useSettingsFileNav } from "./settings/files/useSettingsFileNav.js";
import { DuressPanel } from "./settings/security/DuressPanel.js";
import "./settings.css";

import { useContributions } from "../bindings/contributions.js";
import { useSettingsPanels } from "./settings/rail-snapshot.js";
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

  // Every tab's rail entries are links to its panels; only Security used to
  // follow one, so General › Locking or Vaults › Travel changed the address
  // and left the page where it was. useHashTarget waits for a panel that
  // mounts late (Transport is lazy, a capability's panel arrives with its
  // module) rather than looking once and giving up.
  useHashTarget();
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
  const contributedPanels = useCategoryPanels(category);
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
        {form ? <SettingsPageIndex category={category} /> : null}
        {form && ContributedPanel ? <ContributedPanel /> : null}
        {form && category === "general" ? (
          <>
            <GuideTarget id="settings.install">
              <resolvedPanels.InstallPanel />
            </GuideTarget>
            <GeneralPrefsPanel />
            <KeybindingsPanel />
          </>
        ) : null}

        {form && category === "security" ? (
          <SecurityPanels
            UnlockMethodsPanel={resolvedPanels.UnlockMethodsPanel}
            contributed={contributedPanels}
          />
        ) : null}

        {form && category === "vaults" && (
          <VaultsAndTypes {...resolvedPanels} />
        )}
        {form && category !== "security"
          ? contributedPanels.map(({ id, Panel }) => <Panel key={id} />)
          : null}
        {form && category === "capabilities" ? <CapabilitiesPanel /> : null}
        {form && category === "danger" ? <SettingsDangerPanel /> : null}
      </div>
    </SettingsFileContext.Provider>
  );
}

/** The rail's entries for one category, for the phone's page index. */
function SettingsPageIndex({ category }: { category: string }) {
  const entries =
    settingsPageSources(useSettingsPanels()).find((tab) => tab.id === category)
      ?.sections ?? [];
  return <PageIndex entries={entries} />;
}

/**
 * Panels a capability draws inside a category the core already has, so
 * Security can carry Formats and the ambient opt-in without this file
 * importing them.
 */
function useCategoryPanels(category: string) {
  return [...useContributions("settings-panel")]
    .filter((panel) => panel.category === category)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The Security category's own panels, in the order the screen draws them.
 * A capability's panels take the slot after the unlock methods — where
 * Formats sat when this file drew it itself, and drew it a second time
 * beside the capability's own copy.
 */
function SecurityPanels({
  UnlockMethodsPanel,
  contributed,
}: {
  UnlockMethodsPanel: SettingsPanels["UnlockMethodsPanel"];
  contributed: readonly { id: string; Panel: ComponentType }[];
}) {
  return (
    <>
      <VaultKeyProtectionPanel />
      <UnlockMethodsPanel />
      <DuressPanel />
      {contributed.map(({ id, Panel }) => (
        <Panel key={id} />
      ))}
      <AgeKeysPanel />
      <Suspense fallback={null}>
        <TransportPanel />
      </Suspense>
    </>
  );
}
