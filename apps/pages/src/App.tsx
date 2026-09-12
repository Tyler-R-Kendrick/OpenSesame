import {
  type ComponentType,
  type ReactNode,
  Suspense,
  createContext,
  lazy,
  useContext,
  useEffect,
  useRef,
} from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell as DefaultAppShell } from "./components/AppShell.js";
import { sealPendingConnectorDirectory } from "./lib/connector-directory.js";
import { hasAuthResponse as defaultHasAuthResponse } from "./lib/federation.js";
import { keyboardIsIdle, landFocus } from "./lib/focus.js";
import { recoverPendingFederatedLink } from "./lib/guest-auth.js";
import { resumeStashedJoin } from "./lib/join-session.js";
import { usePaneEscape } from "./lib/pane-escape.js";
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
import { SupportProvider } from "./tutorial/session.js";
import {
  SupportLauncher,
  SupportSlotProvider,
} from "./tutorial/ui/SupportLauncher.js";
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
const LocalAuthorize = lazy(() =>
  import("./screens/LocalAuthorize.js").then((m) => ({
    default: m.LocalAuthorize,
  })),
);
const DefaultSettingsSection = lazy(() =>
  import("./sections/SettingsSection.js").then((m) => ({
    default: m.SettingsSection,
  })),
);

type VaultStatus = { status: string; tomb?: string; guest?: boolean };
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

/**
 * Scrolling frame for every section except the vault, which owns its own
 * panes. Arriving here — `g s`, a rail row, a Back — lands the keyboard on
 * the section itself, so the next Tab is the section's first control rather
 * than the top of the document; a caret a section placed on its own field
 * is left where it is.
 */
function Framed({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const location = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the arrival itself; the effect runs once per navigation
  useEffect(() => {
    if (keyboardIsIdle()) landFocus(ref.current);
  }, [location.key]);
  return (
    <main id="main" className="section" ref={ref} tabIndex={-1}>
      {children}
    </main>
  );
}

/**
 * What an unlock picks back up. A reload drops the in-memory notice but not
 * the upstream assertion in sessionStorage, so a link deferred by a locked
 * vault is raised again from the bell; a stashed join resumes; and a
 * connector directory synced during setup, which waited for a vault to seal
 * it in (ADR 0115), lands in the first open tomb. Each is a no-op when there
 * is nothing outstanding.
 */
function useAfterUnlock(
  status: string,
  tomb: string | undefined,
  guest: boolean | undefined,
): void {
  useEffect(() => {
    if (status !== "unlocked") return;
    recoverPendingFederatedLink();
    void resumeStashedJoin().catch(() => {
      // A spent or expired stash is not a reason to trap the vault.
    });
    if (tomb) {
      // A guest tomb is wiped on lock, so it gets the list without taking
      // it: the sync still waits for the vault that lasts.
      void sealPendingConnectorDirectory(tomb, { ephemeral: guest }).catch(
        () => {
          // The endpoint is on record; Access › Connectors syncs it again.
        },
      );
    }
  }, [status, tomb, guest]);
}

function VaultApp() {
  const slots = useContext(AppSlotsContext);
  const { status, tomb, guest } = slots.useVault();
  const location = useLocation();
  slots.useTheme();
  slots.useSessionGuards();
  useWebMcp(status);
  useAfterUnlock(status, tomb, guest);

  if (status !== "unlocked") {
    return <slots.UnlockScreen />;
  }

  // Land on the vault before the shell mounts: the rail's sections open from
  // the route they first render under, and mounting on "/" would leave every
  // one of them closed.
  if (location.pathname === "/") {
    return <Navigate to="/vault" replace />;
  }

  return (
    <slots.AppShell>
      <Suspense fallback={<p className="hint">Loading…</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/vault" replace />} />
          <Route path="/vault" element={<slots.VaultSection />}>
            <Route index element={<slots.VaultWelcome />} />
            <Route path="health" element={<slots.HealthPanel />} />
            <Route
              path="new/:kind?"
              element={<slots.ItemEditor mode="new" />}
            />
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
            path="/identity/authorize"
            element={
              <Framed>
                <LocalAuthorize />
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
 * stays behind the master-password gate. Support sits outside that gate so
 * the overlay is on every screen, including unlock, setup and ceremonies.
 */
export function App({ slots }: { slots?: Partial<AppSlots> } = {}) {
  usePaneEscape();
  const resolved = { ...defaultSlots, ...slots };
  const location = useLocation();

  const body = resolved.hasAuthResponse(location.search) ? (
    <resolved.FederationReturn />
  ) : location.pathname === "/broker/authorize" ? (
    <resolved.BrokerAuthorize />
  ) : (
    <VaultApp />
  );

  return (
    <AppSlotsContext.Provider value={resolved}>
      <SupportProvider>
        <SupportSlotProvider>
          {body}
          <SupportLauncher />
        </SupportSlotProvider>
      </SupportProvider>
    </AppSlotsContext.Provider>
  );
}
