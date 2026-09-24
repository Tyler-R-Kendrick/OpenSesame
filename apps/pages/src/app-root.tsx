import { activatePlan } from "@opensesame/app-core/lib/capabilities/change.js";
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
import {
  Link,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
} from "react-router";
import { Wrapped } from "./components/ShellWrappers.js";
import { ContextMenuLayer } from "./components/context-menu/ContextMenuLayer.js";

import type {
  RouteContribution,
  ShellWrapperContribution,
  UnlockEffectContribution,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { planIsSettling } from "@opensesame/app-core/lib/capabilities/settling.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { hasAuthResponse as defaultHasAuthResponse } from "@opensesame/app-core/lib/federation.js";
import { recoverPendingFederatedLink as defaultRecoverPendingFederatedLink } from "@opensesame/app-core/lib/guest-auth.js";
import { keyboardIsIdle, landFocus } from "./lib/focus.js";
import { usePaneEscape } from "./lib/pane-escape.js";
import {
  useSessionGuards as defaultUseSessionGuards,
  useTheme as defaultUseTheme,
  useVault as defaultUseVault,
} from "./lib/vault/hooks.js";
import { FederationReturn as DefaultFederationReturn } from "./screens/FederationReturn.js";
import { UnlockScreen as DefaultUnlockScreen } from "./screens/UnlockScreen.js";

import { useComposition } from "./bindings/capabilities.js";
import { useRegistryContributions as defaultUseContributions } from "./bindings/contributions.js";
// The core shell (ownership.md §5): unlock, the vault, Settings, and the
// federation return. Every other section arrives as a `route` contribution
// from an approved capability's runtime, so nothing optional is imported
// here — not even lazily. A lazy import is still a reference the bundle graph
// follows; a contribution is a value a module hands over once it is approved.
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
  useRouteContributions: () => readonly RouteContribution[];
  useUnlockEffects: () => readonly UnlockEffectContribution[];
  useShellWrappers: () => readonly ShellWrapperContribution[];
  /** Core sign-in: raise a federated link a locked vault deferred (ADR 0033). */
  recoverPendingFederatedLink: () => void;
  AppShell: ComponentType<{ children?: ReactNode }>;
  FederationReturn: ComponentType;
  UnlockScreen: ComponentType;
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
  useRouteContributions: () => defaultUseContributions("route"),
  useUnlockEffects: () => defaultUseContributions("unlock-effect"),
  useShellWrappers: () => defaultUseContributions("shell-wrapper"),
  recoverPendingFederatedLink: defaultRecoverPendingFederatedLink,
  AppShell: DefaultAppShell,
  FederationReturn: DefaultFederationReturn,
  UnlockScreen: DefaultUnlockScreen,
  SettingsSection: DefaultSettingsSection,
  VaultSection: DefaultVaultSection,
  VaultWelcome: DefaultVaultWelcome,
  HealthPanel: DefaultHealthPanel,
  ItemDetail: DefaultItemDetail,
  ItemEditor: DefaultItemEditor,
};

const AppSlotsContext = createContext<AppSlots>(defaultSlots);

/**
 * Path prefixes that belong to optional sections. While the capability that
 * owns one is unapproved, a deep link there is answered with
 * `UnavailableRoute` rather than a silent redirect, so the person learns the
 * function is absent on this installation (SURFACE/LOAD-03). S02 may replace
 * the list from the catalog's section ownership.
 */
export const appRootSeams = {
  optionalSectionPrefixes: (): readonly string[] => [
    "/access",
    "/agents",
    "/sites",
    "/identity",
    "/connections",
    "/wallet",
    "/activity",
    "/claim",
    "/broker",
  ],
};

export function matchesOptionalSection(pathname: string): boolean {
  return appRootSeams
    .optionalSectionPrefixes()
    .some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Neutral answer for a known optional path this installation does not carry. */
export function UnavailableRoute() {
  return (
    <main id="main" className="section" tabIndex={-1}>
      <p className="hint">Not available on this installation.</p>
      <Link to="/vault">Vault</Link>
    </main>
  );
}

/** Whether a capability is approved under the current plan, and its lifecycle. */
export function useCapabilityGate(id: string) {
  const snapshot = useComposition();
  const state = snapshot.plan?.capabilities[id] ?? null;
  return {
    approved: state?.approved === true,
    lifecycle: snapshot.lifecycle[id] ?? null,
    state,
  };
}

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
 * Unlock effects an approved module registered run once per unlock, under
 * the lease that approved them: a bump aborts the signal they were handed.
 *
 * Locking clears any active duress presentation first (ADR 0131). That is
 * core, not an unlock effect: it must run whether or not a tomb is open and
 * whether or not a capability contributed anything, so it sits ahead of the
 * early return rather than inside the effect list.
 */
function useAfterUnlock(
  status: string,
  tomb: string | undefined,
  guest: boolean | undefined,
  effects: readonly UnlockEffectContribution[],
  recover: () => void,
): void {
  useEffect(() => {
    if (status !== "unlocked") {
      void import(
        "@opensesame/app-core/lib/duress/compartment/presentation-runtime.js"
      ).then(({ clearActivePresentation }) => clearActivePresentation());
      return;
    }
    if (!tomb) return;
    recover();
    const controller = new AbortController();
    let leaseSignal: AbortSignal | null = null;
    try {
      leaseSignal = compositionStore.currentLease().signal;
    } catch {
      // Not resolved yet: the effects run again on the next generation.
    }
    const onLeaseAbort = () => controller.abort("lease");
    leaseSignal?.addEventListener("abort", onLeaseAbort, { once: true });
    for (const effect of effects) {
      void effect
        .run({ tomb, guest: guest === true, signal: controller.signal })
        .catch(() => undefined);
    }
    return () => {
      leaseSignal?.removeEventListener("abort", onLeaseAbort);
      controller.abort("unmount");
    };
  }, [status, tomb, guest, effects, recover]);
}

function contributedRoute(route: RouteContribution) {
  const Element = route.element;
  return (
    <Route
      key={route.id}
      path={route.path}
      element={
        route.framed ? (
          <Framed>
            <Element />
          </Framed>
        ) : (
          <Element />
        )
      }
    />
  );
}

function Fallback() {
  const location = useLocation();
  const snapshot = useComposition();
  // Nothing is decided while the plan is still coming up: an approved
  // capability registers its routes when its module activates, and a cold
  // deep link can match before that (`lib/capabilities/settling.ts`).
  if (planIsSettling(snapshot)) return null;
  if (matchesOptionalSection(location.pathname)) return <UnavailableRoute />;
  return <Navigate to="/vault" replace />;
}

function VaultApp() {
  const slots = useContext(AppSlotsContext);
  const { status, tomb, guest } = slots.useVault();
  const location = useLocation();
  const routes = slots.useRouteContributions();
  const wrappers = slots.useShellWrappers();
  const effects = slots.useUnlockEffects();
  slots.useTheme();
  slots.useSessionGuards();
  useAfterUnlock(
    status,
    tomb,
    guest,
    effects,
    slots.recoverPendingFederatedLink,
  );

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
      <Wrapped wrappers={wrappers}>
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
              {routes.map(contributedRoute)}
              <Route
                path="/settings/:category?"
                element={
                  <Framed>
                    <slots.SettingsSection />
                  </Framed>
                }
              />
              <Route path="*" element={<Fallback />} />
            </Routes>
          </Suspense>
        </slots.AppShell>
      </Wrapped>
    </Suspense>
  );
}

/** A contributed route allowed on a locked device, matching this location. */
function ungatedRoute(
  routes: readonly RouteContribution[],
  pathname: string,
): RouteContribution | null {
  return (
    routes.find(
      (route) =>
        route.gate === "any" && matchPath(route.path, pathname) !== null,
    ) ?? null
  );
}

/**
 * The federated return runs without unlocking the vault, as does any route a
 * module marked `gate: "any"` (a popup or claim page that holds no key).
 * Everything else stays behind the master-password gate.
 */
export function AppRoot({ slots }: { slots?: Partial<AppSlots> } = {}) {
  usePaneEscape();
  const resolved = { ...defaultSlots, ...slots };
  const location = useLocation();
  const routes = resolved.useRouteContributions();
  const isAuthCallback = resolved.hasAuthResponse(location.search);
  useEffect(() => activatePlan(compositionStore), []);

  const ungated = isAuthCallback
    ? null
    : ungatedRoute(routes, location.pathname);
  const Ungated = ungated?.element;
  const body = isAuthCallback ? (
    <resolved.FederationReturn />
  ) : Ungated ? (
    <Ungated />
  ) : (
    <VaultApp />
  );

  return (
    <AppSlotsContext.Provider value={resolved}>
      {body}
      <ContextMenuLayer />
    </AppSlotsContext.Provider>
  );
}
