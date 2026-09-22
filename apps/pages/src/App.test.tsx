import { cleanup, render, screen } from "@testing-library/react";
import { Outlet } from "react-router";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, type AppSlots } from "./App.js";
import type {
  RouteContribution,
  UnlockEffectContribution,
} from "./lib/capabilities/runtime-contract.js";

const env = {
  hasAuthResponse: false,
  vaultStatus: "locked",
  routes: [] as RouteContribution[],
  effects: [] as UnlockEffectContribution[],
  recovered: 0,
};

const testSlots: Partial<AppSlots> = {
  hasAuthResponse: () => env.hasAuthResponse,
  useVault: () => ({ status: env.vaultStatus, tomb: "personal", guest: false }),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => env.routes,
  useUnlockEffects: () => env.effects,
  recoverPendingFederatedLink: () => {
    env.recovered += 1;
  },
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  FederationReturn: () => <p>federation return stub</p>,
  UnlockScreen: () => <p>unlock screen stub</p>,
  SettingsSection: () => <p>settings section</p>,
  VaultSection: () => (
    <div>
      vault section
      <Outlet />
    </div>
  ),
  VaultWelcome: () => <p>vault welcome</p>,
  HealthPanel: () => <p>health panel</p>,
  ItemDetail: () => <p>item detail</p>,
  ItemEditor: ({ mode }) => <p>item editor {mode}</p>,
};

function renderApp(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App slots={testSlots} />
    </MemoryRouter>,
  );
}

const connectionsRoute: RouteContribution = {
  id: "connectors.external/section",
  path: "/connections/:providerId?/:connectionId?",
  element: () => <p>connections section</p>,
  framed: true,
  order: 20,
};

const brokerRoute: RouteContribution = {
  id: "access.authority/broker",
  path: "/broker/authorize",
  element: () => <p>broker authorize stub</p>,
  framed: false,
  order: 90,
  gate: "any",
};

describe("App", () => {
  beforeEach(() => {
    env.hasAuthResponse = false;
    env.vaultStatus = "locked";
    env.routes = [];
    env.effects = [];
    env.recovered = 0;
  });

  afterEach(cleanup);

  it("finishes federation sign-in before anything else", () => {
    env.hasAuthResponse = true;
    env.routes = [brokerRoute];
    renderApp("/broker/authorize?code=abc&state=xyz");
    expect(screen.getByText("federation return stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("gates the whole app behind the unlock screen", () => {
    renderApp("/vault");
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("serves a contributed `gate: any` route without unlocking, and nothing else", () => {
    env.routes = [brokerRoute, connectionsRoute];
    renderApp("/broker/authorize?client_id=x");
    expect(screen.getByText("broker authorize stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    cleanup();
    renderApp("/connections");
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
  });

  it("withholds an optional popup route the plan did not contribute", () => {
    renderApp("/broker/authorize?client_id=x");
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
  });

  it("redirects the root to the vault once unlocked", () => {
    env.vaultStatus = "unlocked";
    renderApp("/");
    expect(screen.getByText("vault section")).toBeTruthy();
    expect(screen.getByText("vault welcome")).toBeTruthy();
  });

  it("renders vault sub-routes inside the vault section", () => {
    env.vaultStatus = "unlocked";
    const { unmount } = renderApp("/vault/health");
    expect(screen.getByText("health panel")).toBeTruthy();
    unmount();

    for (const path of ["/vault/new", "/vault/new/login"]) {
      const second = renderApp(path);
      expect(screen.getByText("item editor new")).toBeTruthy();
      second.unmount();
    }

    const third = renderApp("/vault/item_1/edit");
    expect(screen.getByText("item editor edit")).toBeTruthy();
    third.unmount();

    renderApp("/vault/item_1");
    expect(screen.getByText("item detail")).toBeTruthy();
  });

  it("frames Settings and every framed contributed route inside the shell", () => {
    env.vaultStatus = "unlocked";
    env.routes = [connectionsRoute];
    const cases: Array<[string, string]> = [
      ["/connections", "connections section"],
      ["/connections/github/conn_1", "connections section"],
      ["/settings", "settings section"],
      ["/settings/", "settings section"],
      ["/settings/connections", "settings section"],
    ];
    for (const [route, marker] of cases) {
      const { unmount } = renderApp(route);
      expect(screen.getByText(marker)).toBeTruthy();
      expect(screen.getByTestId("app-shell")).toBeTruthy();
      expect(screen.getByRole("main")).toBeTruthy();
      unmount();
    }
  });

  it("answers a known optional section the plan lacks with the unavailable route", () => {
    env.vaultStatus = "unlocked";
    for (const route of ["/access", "/identity", "/connections/github", "/wallet", "/activity"]) {
      const { unmount } = renderApp(route);
      expect(screen.getByText("Not available on this installation.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Vault" })).toBeTruthy();
      expect(screen.queryByText("vault welcome")).toBeNull();
      unmount();
    }
  });

  it("redirects unknown routes to the vault", () => {
    env.vaultStatus = "unlocked";
    for (const route of ["/definitely-not-a-route", "/authority", "/authentication"]) {
      const { unmount } = renderApp(route);
      expect(screen.getByText("vault welcome")).toBeTruthy();
      unmount();
    }
  });

  it("runs contributed unlock effects and the core federated-link recovery once unlocked", async () => {
    env.vaultStatus = "unlocked";
    const seen: Array<{ tomb: string; guest: boolean }> = [];
    env.effects = [
      {
        id: "connectors.external/seal-directory",
        run: async ({ tomb, guest }) => {
          seen.push({ tomb, guest });
        },
      },
    ];
    renderApp("/vault");
    await Promise.resolve();
    expect(seen).toEqual([{ tomb: "personal", guest: false }]);
    expect(env.recovered).toBe(1);
  });

  it("runs nothing after unlock while locked", () => {
    env.effects = [
      {
        id: "x",
        run: async () => {
          throw new Error("must not run");
        },
      },
    ];
    renderApp("/vault");
    expect(env.recovered).toBe(0);
  });
});

describe("App — where the keyboard lands", () => {
  it("lands a framed section on its content so Tab starts inside it", () => {
    env.vaultStatus = "unlocked";
    renderApp("/settings");
    expect(screen.getByText("settings section")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
