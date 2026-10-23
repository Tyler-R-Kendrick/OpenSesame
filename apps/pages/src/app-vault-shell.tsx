import type {
  RouteContribution,
  ShellWrapperContribution,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { JOIN_COMMAND_PATH } from "@opensesame/app-core/lib/command-bar/types.js";
import { type ComponentType, Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import type { AppSlots } from "./app-root.js";
import { useRenewingShellWrappers } from "./bindings/shell-wrappers.js";
import { Framed } from "./components/RouteFrame.js";
import { Wrapped } from "./components/ShellWrappers.js";
import {
  VaultContentSkeleton,
  VaultShellSkeleton,
} from "./components/VaultShellSkeleton.js";
import { JoinRoadRoute } from "./screens/join/JoinRoad.js";

const DefaultSaveRequestScreen = lazy(() =>
  import("./screens/SaveRequestScreen.js").then((m) => ({
    default: m.SaveRequestScreen,
  })),
);

/** Whether a capability is approved under the current plan, and its lifecycle. */
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

/** The unlocked shell keeps separate shell and section loading boundaries. */
export function AppVaultShell({
  slots,
  wrappers,
  routes,
  fallback: Fallback,
}: {
  slots: AppSlots;
  wrappers: readonly ShellWrapperContribution[];
  routes: readonly RouteContribution[];
  fallback: ComponentType;
}) {
  const renewedWrappers = useRenewingShellWrappers(wrappers);
  return (
    // The shell is one Suspense boundary and the section inside it another,
    // so a section still loading never blanks the rail around it.
    <Suspense fallback={<VaultShellSkeleton />}>
      <Wrapped wrappers={renewedWrappers}>
        <slots.AppShell>
          <Suspense fallback={<VaultContentSkeleton />}>
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
                path="/settings/vault"
                element={<Navigate to="/settings" replace />}
              />
              <Route
                path="/settings/user"
                element={<Navigate to="/settings/keybindings" replace />}
              />
              <Route
                path="/settings/features/:featureId/:capabilityId?"
                element={
                  <Framed>
                    <slots.SettingsSection />
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
              <Route
                path="/save"
                element={
                  <Suspense fallback={<VaultContentSkeleton />}>
                    <DefaultSaveRequestScreen />
                  </Suspense>
                }
              />
              <Route path={JOIN_COMMAND_PATH} element={<JoinRoadRoute />} />
              <Route path="*" element={<Fallback />} />
            </Routes>
          </Suspense>
        </slots.AppShell>
      </Wrapped>
    </Suspense>
  );
}
