import { type ComponentType, Suspense, lazy, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { PageIndex } from "../components/PageIndex.js";
import { useHashTarget } from "../lib/hash-target.js";
import { settingsPageSources } from "./settings/page-tree.js";
import { DeadmanPanel } from "./settings/security/DeadmanPanel.js";
import { useSettingsCategory } from "./settings/use-settings-category.js";

import { settingsPath } from "@opensesame/app-core/lib/crumbs.js";
import { retiredSettingsAddress } from "@opensesame/app-core/lib/settings-retired.js";
import {
  categoryFromHash,
  settingsGroupForCategory,
  settingsTabsForGroup,
} from "@opensesame/app-core/sections/settings-section-nav-model.js";
import {
  hasLinkedPairing,
  subscribeLinkedPairing,
} from "../lib/pairing-link.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { SettingsDangerPanel } from "./SettingsDangerPanel.js";
import {
  CategoryLink,
  SECURITY_FRAGMENT_REDIRECT,
  type SettingsPanels,
  defaultPanels,
  useSettingsTabs,
} from "./SettingsSectionNav.js";
import { FeatureConfigPanel } from "./settings/FeatureConfigPanel.js";
import { FeaturesPanel } from "./settings/FeaturesPanel.js";
import { GeneralPrefsPanel } from "./settings/GeneralPrefsPanel.js";
import { IntegrationsPanel } from "./settings/IntegrationsPanel.js";
import { ItemTypesPanel } from "./settings/ItemTypesPanel.js";
import { VaultKeyProtectionPanel } from "./settings/VaultKeyProtectionPanel.js";
import { featureConfigPath } from "./settings/feature-config-path.js";
import { SettingsFiles } from "./settings/files/SettingsFiles.js";
import { SettingsFileContext } from "./settings/files/context.js";
import { isSettingsDocument } from "./settings/files/documents.js";
import { useCategoryFiles } from "./settings/files/providers.js";
import { useSettingsFileNav } from "./settings/files/useSettingsFileNav.js";
import {
  DuressPanel,
  useDuressPanelShown,
} from "./settings/security/DuressPanel.js";
import { TravelPanel } from "./settings/travel/TravelPanel.js";
import "./settings.css";

import { useContributions } from "../bindings/contributions.js";
import { useSettingsPanels } from "./settings/rail-snapshot.js";
/** Its own chunk: the keymap editor is read on a Keybindings visit. */
const KeybindingsPanels = lazy(() =>
  import("./settings/keybindings/KeybindingsPanels.js").then((module) => ({
    default: module.KeybindingsPanels,
  })),
);

export type { SettingsPanels } from "./SettingsSectionNav.js";

/**
 * An old `#fragment` link lands on its category's path, a retired Capabilities
 * or Connections address on Features or Integrations (with its section and
 * file), a retired Security fragment on its new home, and a live one scrolls
 * into view.
 */
function useSettingsLocation(
  category: string,
  hash: string,
  pathname: string,
  search: string,
) {
  const navigate = useNavigate();
  // One navigation per address: every `#fragment` lands on its category's path.
  useEffect(() => {
    const retired = retiredSettingsAddress(pathname, search, hash);
    if (retired !== null) {
      navigate(retired, { replace: true });
      return;
    }
    const fromPath = pathname.match(/\/settings\/[^/]+/) !== null;
    const target = fromPath ? null : categoryFromHash(hash);
    if (target) navigate(settingsPath(target, hash), { replace: true });
  }, [hash, navigate, pathname, search]);

  // A drive pairing link used to land on User Settings › Vaults. Its panel
  // now lives on Networking's page; keep old links working by carrying the
  // captured code there before the panel can take it.
  useEffect(() => {
    if (category !== "vaults") return;
    const go = () => {
      if (!hasLinkedPairing()) return;
      navigate(featureConfigPath("networking"), {
        replace: true,
      });
    };
    go();
    return subscribeLinkedPairing(go);
  }, [category, navigate]);

  // Item types were a panel of Vaults before they had their own vault tab.
  useEffect(() => {
    if (category !== "vaults" || hash !== "#item-types") return;
    navigate(settingsPath("item-types"), { replace: true });
  }, [category, hash, navigate]);

  // Keybindings were a panel of General before they had a tab (ADR 0156).
  useEffect(() => {
    if (category !== "general") return;
    if (hash !== "#settings-keybindings") return;
    navigate(settingsPath("keybindings"), { replace: true });
  }, [category, hash, navigate]);

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
  const { featureId, capabilityId } = useParams<{
    featureId?: string;
    capabilityId?: string;
  }>();
  const tabs = useSettingsTabs();
  const category = useSettingsCategory();
  const group = settingsGroupForCategory(category);
  const groupTabs = settingsTabsForGroup(tabs, group.id);
  const ContributedPanel = tabs.find((tab) => tab.id === category)?.Panel;
  const contributedPanels = useCategoryPanels(category);
  // A directory's files are addressed by `?file=` (the rail, the command bar,
  // a row's open key). Its own `config.yaml` and the capability documents are
  // the page itself, drawn as every page is; only a file a provider keeps for
  // authoring (an item type's JSON, a routing file) opens in the file viewer
  // in place of the form.
  const { openPath, setOpenPath, fileNav } = useSettingsFileNav(
    category,
    search,
  );
  const provided = useCategoryFiles(category);
  const file =
    openPath !== null &&
    provided !== null &&
    !isSettingsDocument(category, openPath)
      ? openPath
      : null;

  useSettingsLocation(category, hash, pathname, search);

  const form = file === null;

  return (
    <SettingsFileContext.Provider value={fileNav}>
      <div className="section__inner">
        <div className="section__head">
          <h1>{group.label}</h1>
        </div>

        <SettingsCategoryNav tabs={groupTabs} category={category} />
        {file === null ? null : (
          <SettingsFiles
            category={category}
            selected={file}
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
          </>
        ) : null}
        {form && category === "keybindings" ? (
          <Suspense fallback={null}>
            <KeybindingsPanels />
          </Suspense>
        ) : null}

        {form && category === "security" ? (
          <SecurityPanels
            UnlockMethodsPanel={resolvedPanels.UnlockMethodsPanel}
            contributed={contributedPanels}
          />
        ) : null}

        {form && category === "vaults" ? <resolvedPanels.VaultsPanel /> : null}
        {form && category === "item-types" ? <ItemTypesPanel /> : null}
        {form && category !== "security"
          ? contributedPanels.map(({ id, Panel }) => <Panel key={id} />)
          : null}
        {form && category === "features" ? (
          featureId ? (
            <FeatureConfigPanel
              featureId={featureId}
              capabilityId={capabilityId}
            />
          ) : (
            <FeaturesPanel />
          )
        ) : null}
        {form && category === "integrations" ? <IntegrationsPanel /> : null}
        {form && category === "danger" ? <SettingsDangerPanel /> : null}
      </div>
    </SettingsFileContext.Provider>
  );
}

function SettingsCategoryNav({
  tabs,
  category,
}: {
  tabs: ReturnType<typeof settingsTabsForGroup>;
  category: string;
}) {
  return (
    <nav className="set__nav" aria-label="Settings sections">
      {tabs.map((entry) => (
        <CategoryLink
          key={entry.id}
          guideId={entry.guideId}
          to={settingsPath(entry.id)}
          label={entry.label}
          current={category === entry.id}
        />
      ))}
    </nav>
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
 * Security can carry an ambient opt-in without this file importing it.
 */
function useCategoryPanels(category: string) {
  return [...useContributions("settings-panel")]
    .filter((panel) => panel.category === category)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The Security category's own panels, in the order the screen draws them.
 * A capability's panels take the slot after the unlock methods.
 */
function SecurityPanels({
  UnlockMethodsPanel,
  contributed,
}: {
  UnlockMethodsPanel: SettingsPanels["UnlockMethodsPanel"];
  contributed: readonly { id: string; Panel: ComponentType }[];
}) {
  // Travel is duress's own extension (ADR 0143): it draws exactly where the
  // duress row does — the owner of an open vault, never a guest.
  const duressShown = useDuressPanelShown();
  return (
    <>
      <VaultKeyProtectionPanel />
      <UnlockMethodsPanel />
      {contributed.map(({ id, Panel }) => (
        <Panel key={id} />
      ))}
      <DuressPanel />
      <DeadmanPanel />
      {duressShown ? <TravelPanel /> : null}
    </>
  );
}
