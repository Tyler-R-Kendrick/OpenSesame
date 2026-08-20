import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell as DefaultAppShell } from "./components/AppShell.js";
import { hasAuthResponse as defaultHasAuthResponse } from "./lib/federation.js";
import {
  useSessionGuards as defaultUseSessionGuards,
  useTheme as defaultUseTheme,
  useVault as defaultUseVault,
} from "./lib/vault/hooks.js";
import { BrokerAuthorize as DefaultBrokerAuthorize } from "./screens/BrokerAuthorize.js";
import { FederationReturn as DefaultFederationReturn } from "./screens/FederationReturn.js";
import { UnlockScreen as DefaultUnlockScreen } from "./screens/UnlockScreen.js";
import { AgentsSection as DefaultAgentsSection } from "./sections/AgentsSection.js";
import { AuthoritySection as DefaultAuthoritySection } from "./sections/AuthoritySection.js";
import { ConnectionsSection as DefaultConnectionsSection } from "./sections/ConnectionsSection.js";
import { SettingsSection as DefaultSettingsSection } from "./sections/SettingsSection.js";
import { SitesSection as DefaultSitesSection } from "./sections/SitesSection.js";
import {
  VaultSection as DefaultVaultSection,
  VaultWelcome as DefaultVaultWelcome,
} from "./sections/VaultSection.js";
import { HealthPanel as DefaultHealthPanel } from "./sections/vault/HealthPanel.js";
import { ItemDetail as DefaultItemDetail } from "./sections/vault/ItemDetail.js";
import { ItemEditor as DefaultItemEditor } from "./sections/vault/ItemEditor.js";

type VaultStatus = { status: string };
type EditorProps = { mode: string };

export type AppSlots = {
  hasAuthResponse: (search: string) => boolean;
  useVault: () => VaultStatus;
  useTheme: () => void;
  useSessionGuards: () => void;
  AppShell: ComponentType<{ children?: ReactNode }>;
  BrokerAuthorize: ComponentType;
  FederationReturn: ComponentType;
  UnlockScreen: ComponentType;
  AgentsSection: ComponentType;
  AuthoritySection: ComponentType;
  ConnectionsSection: ComponentType;
  SettingsSection: ComponentType;
  SitesSection: ComponentType;
  VaultSection: ComponentType;
  VaultWelcome: ComponentType;
  HealthPanel: ComponentType;
  ItemDetail: ComponentType;
  ItemEditor: ComponentType<EditorProps>;
};

const defaultSlots: AppSlots = {
  hasAuthResponse: defaultHasAuthResponse,
  useVault: defaultUseVault,
  useTheme: defaultUseTheme,
  useSessionGuards: defaultUseSessionGuards,
  AppShell: DefaultAppShell,
  BrokerAuthorize: DefaultBrokerAuthorize,
  FederationReturn: DefaultFederationReturn,
  UnlockScreen: DefaultUnlockScreen,
  AgentsSection: DefaultAgentsSection,
  AuthoritySection: DefaultAuthoritySection,
  ConnectionsSection: DefaultConnectionsSection,
  SettingsSection: DefaultSettingsSection,
  SitesSection: DefaultSitesSection,
  VaultSection: DefaultVaultSection,
  VaultWelcome: DefaultVaultWelcome,
  HealthPanel: DefaultHealthPanel,
  ItemDetail: DefaultItemDetail,
  ItemEditor: DefaultItemEditor,
};

const AppSlotsContext = createContext<AppSlots>(defaultSlots);

/** Scrolling frame for every section except the vault, which owns its own panes. */
function Framed({ children }: { children: ReactNode }) {
  return <main className="section">{children}</main>;
}

function VaultApp() {
  const slots = useContext(AppSlotsContext);
  const { status } = slots.useVault();
  slots.useTheme();
  slots.useSessionGuards();

  if (status !== "unlocked") {
    return <slots.UnlockScreen />;
  }

  return (
    <slots.AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/vault" replace />} />
        <Route path="/vault" element={<slots.VaultSection />}>
          <Route index element={<slots.VaultWelcome />} />
          <Route path="health" element={<slots.HealthPanel />} />
          <Route path="new/:kind" element={<slots.ItemEditor mode="new" />} />
          <Route path=":itemId/edit" element={<slots.ItemEditor mode="edit" />} />
          <Route path=":itemId" element={<slots.ItemDetail />} />
        </Route>
        <Route
          path="/agents"
          element={
            <Framed>
              <slots.AgentsSection />
            </Framed>
          }
        />
        <Route
          path="/connections/:providerId?/:connectionId?"
          element={
            <Framed>
              <slots.ConnectionsSection />
            </Framed>
          }
        />
        <Route
          path="/sites"
          element={
            <Framed>
              <slots.SitesSection />
            </Framed>
          }
        />
        <Route
          path="/authority"
          element={
            <Framed>
              <slots.AuthoritySection />
            </Framed>
          }
        />
        <Route
          path="/settings"
          element={
            <Framed>
              <slots.SettingsSection />
            </Framed>
          }
        />
        <Route path="*" element={<Navigate to="/vault" replace />} />
      </Routes>
    </slots.AppShell>
  );
}

/**
 * Broker + federated return run without unlocking the vault. Everything else
 * stays behind the master-password gate.
 */
export function App({ slots }: { slots?: Partial<AppSlots> } = {}) {
  const resolved = { ...defaultSlots, ...slots };
  const location = useLocation();

  if (resolved.hasAuthResponse(location.search)) {
    return (
      <AppSlotsContext.Provider value={resolved}>
        <resolved.FederationReturn />
      </AppSlotsContext.Provider>
    );
  }

  if (location.pathname === "/broker/authorize") {
    return (
      <AppSlotsContext.Provider value={resolved}>
        <resolved.BrokerAuthorize />
      </AppSlotsContext.Provider>
    );
  }

  return (
    <AppSlotsContext.Provider value={resolved}>
      <VaultApp />
    </AppSlotsContext.Provider>
  );
}
