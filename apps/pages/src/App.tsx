import {
  type ComponentType,
  type ReactNode,
  Suspense,
  createContext,
  lazy,
  useContext,
  useEffect,
} from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell as DefaultAppShell } from "./components/AppShell.js";
import { hasAuthResponse as defaultHasAuthResponse } from "./lib/federation.js";
import { recoverPendingFederatedLink } from "./lib/guest-auth.js";
import { resumeStashedJoin } from "./lib/join-session.js";
import {
  useSessionGuards as defaultUseSessionGuards,
  useTheme as defaultUseTheme,
  useVault as defaultUseVault,
} from "./lib/vault/hooks.js";
import { BrokerAuthorize as DefaultBrokerAuthorize } from "./screens/BrokerAuthorize.js";
import { FederationReturn as DefaultFederationReturn } from "./screens/FederationReturn.js";
import { UnlockScreen as DefaultUnlockScreen } from "./screens/UnlockScreen.js";
import {
  VaultSection as DefaultVaultSection,
  VaultWelcome as DefaultVaultWelcome,
} from "./sections/VaultSection.js";
import { HealthPanel as DefaultHealthPanel } from "./sections/vault/HealthPanel.js";
import { ItemDetail as DefaultItemDetail } from "./sections/vault/ItemDetail.js";
import { ItemEditor as DefaultItemEditor } from "./sections/vault/ItemEditor.js";
import { useWebMcp } from "./webmcp/lifecycle.js";

// Route-level code splitting: the four big sections load on first visit.
// Vault, unlock and the broker/federation returns stay eager — they are the
// critical path every session goes through.
const DefaultAccessSection = lazy(() =>
  import("./sections/AccessSection.js").then((m) => ({
    default: m.AccessSection,
  })),
);
const DefaultConnectionsSection = lazy(() =>
  import("./sections/ConnectionsSection.js").then((m) => ({
    default: m.ConnectionsSection,
  })),
);
const DefaultIdentitySection = lazy(() =>
  import("./sections/IdentitySection.js").then((m) => ({
    default: m.IdentitySection,
  })),
);
const DefaultSettingsSection = lazy(() =>
  import("./sections/SettingsSection.js").then((m) => ({
    default: m.SettingsSection,
  })),
);

type VaultStatus = { status: string };
type EditorProps = { mode: "edit" | "new" };

export type AppSlots = {
  hasAuthResponse: (search: string) => boolean;
  useVault: () => VaultStatus;
  useTheme: () => void;
  useSessionGuards: () => void;
  AppShell: ComponentType<{ children?: ReactNode }>;
  BrokerAuthorize: ComponentType;
  FederationReturn: ComponentType;
  UnlockScreen: ComponentType;
  AccessSection: ComponentType;
  ConnectionsSection: ComponentType;
  IdentitySection: ComponentType;
  SettingsSection: ComponentType;
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
  AccessSection: DefaultAccessSection,
  ConnectionsSection: DefaultConnectionsSection,
  IdentitySection: DefaultIdentitySection,
  SettingsSection: DefaultSettingsSection,
  VaultSection: DefaultVaultSection,
  VaultWelcome: DefaultVaultWelcome,
  HealthPanel: DefaultHealthPanel,
  ItemDetail: DefaultItemDetail,
  ItemEditor: DefaultItemEditor,
};

const AppSlotsContext = createContext<AppSlots>(defaultSlots);

/** Scrolling frame for every section except the vault, which owns its own panes. */
function Framed({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="section">
      {children}
    </main>
  );
}

function VaultApp() {
  const slots = useContext(AppSlotsContext);
  const { status } = slots.useVault();
  slots.useTheme();
  slots.useSessionGuards();
  useWebMcp(status);

  // A reload drops the in-memory notice but not the upstream assertion in
  // sessionStorage. Once the vault is open, raise the prompt again so a link
  // deferred by a locked vault can still be finished from the bell. No-ops
  // unless a link is actually outstanding.
  useEffect(() => {
    if (status !== "unlocked") return;
    recoverPendingFederatedLink();
    void resumeStashedJoin().catch(() => {
      // A spent or expired stash is not a reason to trap the vault.
    });
  }, [status]);

  if (status !== "unlocked") {
    return <slots.UnlockScreen />;
  }

  return (
    <slots.AppShell>
      <Suspense fallback={<p className="hint">Loading…</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/vault" replace />} />
          <Route path="/vault" element={<slots.VaultSection />}>
            <Route index element={<slots.VaultWelcome />} />
            <Route path="health" element={<slots.HealthPanel />} />
            <Route path="new/:kind" element={<slots.ItemEditor mode="new" />} />
            <Route
              path=":itemId/edit"
              element={<slots.ItemEditor mode="edit" />}
            />
            <Route path=":itemId" element={<slots.ItemDetail />} />
          </Route>
          <Route
            path="/access"
            element={
              <Framed>
                <slots.AccessSection />
              </Framed>
            }
          />
          <Route path="/agents" element={<Navigate to="/access" replace />} />
          <Route path="/sites" element={<Navigate to="/access" replace />} />
          <Route
            path="/identity"
            element={
              <Framed>
                <slots.IdentitySection />
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
            path="/settings/:category?"
            element={
              <Framed>
                <slots.SettingsSection />
              </Framed>
            }
          />
          <Route path="*" element={<Navigate to="/vault" replace />} />
        </Routes>
      </Suspense>
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
