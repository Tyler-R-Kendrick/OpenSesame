import { cleanup, render, screen } from "@testing-library/react";
import { Outlet } from "react-router";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, type AppSlots } from "./App.js";

const env = {
  hasAuthResponse: false,
  vaultStatus: "locked",
};

const testSlots: Partial<AppSlots> = {
  hasAuthResponse: () => env.hasAuthResponse,
  useVault: () => ({ status: env.vaultStatus }),
  useTheme: () => {},
  useSessionGuards: () => {},
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  BrokerAuthorize: () => <p>broker authorize stub</p>,
  FederationReturn: () => <p>federation return stub</p>,
  UnlockScreen: () => <p>unlock screen stub</p>,
  AccessSection: () => <p>access section</p>,
  IdentitySection: () => <p>identity section</p>,
  ConnectionsSection: () => <p>connections section</p>,
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

describe("App", () => {
  beforeEach(() => {
    env.hasAuthResponse = false;
    env.vaultStatus = "locked";
  });

  afterEach(cleanup);

  it("finishes federation sign-in before anything else", () => {
    env.hasAuthResponse = true;
    renderApp("/?code=abc&state=xyz");
    expect(screen.getByText("federation return stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("button", { name: "Support" })).toBeTruthy();
  });

  it("serves the broker authorize popup without unlocking", () => {
    renderApp("/broker/authorize?client_id=x");
    expect(screen.getByText("broker authorize stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("button", { name: "Support" })).toBeTruthy();
  });

  it("gates the whole app behind the unlock screen", () => {
    renderApp("/vault");
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("button", { name: "Support" })).toBeTruthy();
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

    const second = renderApp("/vault/new/login");
    expect(screen.getByText("item editor new")).toBeTruthy();
    second.unmount();

    const third = renderApp("/vault/item_1/edit");
    expect(screen.getByText("item editor edit")).toBeTruthy();
    third.unmount();

    renderApp("/vault/item_1");
    expect(screen.getByText("item detail")).toBeTruthy();
  });

  it("frames each top-level section", () => {
    env.vaultStatus = "unlocked";
    const cases: Array<[string, string]> = [
      ["/access", "access section"],
      ["/identity", "identity section"],
      ["/connections", "connections section"],
      ["/connections/github/conn_1", "connections section"],
      ["/settings", "settings section"],
      ["/settings/connectivity", "settings section"],
    ];
    for (const [route, marker] of cases) {
      const { unmount } = renderApp(route);
      expect(screen.getByText(marker)).toBeTruthy();
      expect(screen.getByTestId("app-shell")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Support" })).toBeTruthy();
      unmount();
    }
  });

  it("keeps the support overlay on the locked, broker and unlocked screens", () => {
    for (const route of ["/vault", "/broker/authorize"]) {
      const { unmount } = renderApp(route);
      expect(
        screen.getByRole("button", { name: "Support" }).className,
      ).toContain("support-launch");
      unmount();
    }
    env.vaultStatus = "unlocked";
    renderApp("/vault");
    expect(screen.getByRole("button", { name: "Support" }).className).toContain(
      "support-launch",
    );
  });

  it("redirects /agents to the Access section", () => {
    env.vaultStatus = "unlocked";
    renderApp("/agents");
    expect(screen.getByText("access section")).toBeTruthy();
  });

  it("redirects /sites to the Access section", () => {
    env.vaultStatus = "unlocked";
    renderApp("/sites");
    expect(screen.getByText("access section")).toBeTruthy();
  });

  it("redirects unknown routes to the vault", () => {
    env.vaultStatus = "unlocked";
    renderApp("/definitely-not-a-route");
    expect(screen.getByText("vault welcome")).toBeTruthy();
  });

  it("redirects the removed Authority and Authentication routes to the vault", () => {
    env.vaultStatus = "unlocked";
    for (const route of ["/authority", "/authentication"]) {
      const { unmount } = renderApp(route);
      expect(screen.getByText("vault welcome")).toBeTruthy();
      unmount();
    }
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
