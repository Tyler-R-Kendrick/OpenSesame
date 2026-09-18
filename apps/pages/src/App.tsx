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
import { useAmbientAuthBoot } from "./lib/ambient-auth/boot.js";
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
import {
  disarmVercelConnectAuth,
  hydrateVercelConnectAuth,
} from "./lib/vercel-connect-session.js";
import { BrokerAuthorize as DefaultBrokerAuthorize } from "./screens/BrokerAuthorize.js";
import { DropClaimScreen } from "./screens/DropClaimScreen.js";
import { FederationReturn as DefaultFederationReturn } from "./screens/FederationReturn.js";
import { UnlockScreen as DefaultUnlockScreen } from "./screens/UnlockScreen.js";
import { SupportProvider } from "./tutorial/session.js";
import {
  SupportLauncher,
  SupportSlotProvider,
} from "./tutorial/ui/SupportLauncher.js";
import { useWebMcp } from "./webmcp/lifecycle.js";

// Route-level code splitting. Unlock, the front door and the broker/federation
// returns stay eager: they are the first paint of every session, and on a
// phone over a slow link that paint is what a person waits for. The shell and
// the vault behind the gate load with the unlock — one chunk the service
// worker precaches on install, so only a cold first visit ever waits for it,
// and that visit no longer downloads the whole workspace to draw a sign-in
// card. The other sections load on first visit as before.
const DefaultAppShell = lazy(() =>
  import("./components/AppShell.js").then((m) => ({ default: m.AppShell })),
);
const DefaultVaultSection = lazy(() =>
  import("./sections/VaultSection.js").then((m) => ({
    default: m.VaultSection,
  })),
);
const DefaultVaultWelcome = lazy(() =>
  import("./sections/VaultSection.js").then((m) => ({
    default: m.VaultWelcome,
  })),
);
const DefaultHealthPanel = lazy(() =>
  import("./sections/vault/HealthPanel.js").then((m) => ({
    default: m.HealthPanel,
  })),
);
const DefaultItemDetail = lazy(() =>
  import("./sections/vault/ItemDetail.js").then((m) => ({
    default: m.ItemDetail,
  })),
);
const DefaultItemEditor = lazy(() =>
  import("./sections/vault/ItemEditor.js").then((m) => ({
    default: m.ItemEditor,
  })),
);
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
const SiopAuthorize = lazy(() =>
  import("./screens/SiopAuthorize.js").then((m) => ({
    default: m.SiopAuthorize,
  })),
);
const DefaultSettingsSection = lazy(() =>
  import("./sections/SettingsSection.js").then((m) => ({
    default: m.SettingsSection,
  })),
);
const DefaultWalletSection = lazy(() =>
  import("./sections/WalletSection.js").then((m) => ({
    default: m.WalletSection,
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
  WalletSection: ComponentType;
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
  WalletSection: DefaultWalletSection,
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
    if (status !== "unlocked") {
      disarmVercelConnectAuth();
      return;
    }
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
      void hydrateVercelConnectAuth(tomb, { ephemeral: guest === true }).catch(
        () => {
          // Connect stays on Host fallback until the operator arms a session.
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
    // The shell is one Suspense boundary and the section inside it another,
    // so a section still loading never blanks the rail around it.
    <Suspense fallback={null}>
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
              path="/access/:tab?/:rest?"
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
              path="/identity/siop"
              element={
                <Framed>
                  <SiopAuthorize />
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
              path="/wallet/:category?"
              element={
                <Framed>
                  <slots.WalletSection />
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
    </Suspense>
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
  const isAuthCallback = resolved.hasAuthResponse(location.search);
  useAmbientAuthBoot(isAuthCallback, location.pathname);

  const body = isAuthCallback ? (
    <resolved.FederationReturn />
  ) : location.pathname === "/broker/authorize" ? (
    <resolved.BrokerAuthorize />
  ) : location.pathname === "/claim" ? (
    <DropClaimScreen />
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
