/** @vitest-environment jsdom */
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { NativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import type { TailscaleApp } from "@opensesame/app-core/lib/tailscale/oauth-app.js";
import type { SavedTailscaleApp } from "@opensesame/app-core/lib/tailscale/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, vi } from "vitest";
import { TailscalePanels } from "./TailscalePanels.js";
import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";

type Fixture = {
  saved: SavedTailscaleApp | null;
  app: TailscaleApp | null;
  locks: Set<() => void>;
  changes: Set<() => void>;
  active: boolean;
  guest: boolean;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  changed: ReturnType<typeof vi.fn<() => void>>;
  flash: ReturnType<typeof vi.fn<(flash: Flash) => void>>;
  authorize: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>;
};
export const fixture: Fixture = {
  saved: null,
  app: null,
  locks: new Set(),
  changes: new Set(),
  active: true,
  guest: false,
  fetch: vi.fn<typeof fetch>(),
  changed: vi.fn<() => void>(),
  flash: vi.fn<(flash: Flash) => void>(),
  authorize: vi.fn<(url: string) => Promise<string>>(),
};
export const port: NativeOAuthBrowserPort = {
  redirectUri: "https://operator.example/oauth-callback",
  navigate: () => undefined,
  scrubCallback: () => undefined,
  authorize: fixture.authorize,
  prepareAuthorization: () => () => undefined,
};
function bindPorts() {
  vi.spyOn(deps, "transport").mockReturnValue({
    fetch: fixture.fetch,
    assertCurrent() {
      if (!fixture.active) throw new Error("inactive");
    },
  });
  vi.spyOn(deps, "browser").mockReturnValue(port);
  vi.spyOn(deps, "optionalBrowser").mockReturnValue(port);
  vi.spyOn(deps, "redirectUri").mockReturnValue(port.redirectUri);
  vi.spyOn(deps, "session").mockReturnValue({
    current: () => ({ tomb: "owner-vault", guest: fixture.guest }),
    close: () => undefined,
  });
  vi.spyOn(deps, "onVaultChange").mockImplementation((callback) => {
    fixture.changes.add(callback);
    return () => {
      fixture.changes.delete(callback);
    };
  });
  vi.spyOn(deps, "onLock").mockImplementation((callback) => {
    fixture.locks.add(callback);
    return () => {
      fixture.locks.delete(callback);
    };
  });
  vi.spyOn(deps, "hydrateTailscaleApps").mockResolvedValue(undefined);
  vi.spyOn(deps, "readTailscaleApp").mockImplementation(() => fixture.saved);
  vi.spyOn(deps, "assertTailscaleAppCurrent").mockImplementation(() => {
    if (!fixture.saved) throw new Error("removed");
  });
  vi.spyOn(deps, "saveTailscaleApp").mockImplementation(async (config, app) => {
    fixture.app = app;
    fixture.saved = {
      ...config,
      id: app.id,
      scopes: app.scopes,
      redirectURIs: app.redirectURIs,
      credentialReference: "opaque-vault-ref",
      vaultTomb: "owner-vault",
      connectionId: "conn_local_tailscale",
    };
    return fixture.saved;
  });
  vi.spyOn(deps, "openTailscaleApp").mockImplementation(() => {
    if (!fixture.app) throw new Error("Missing fixture app");
    return fixture.app;
  });
  vi.spyOn(deps, "forgetTailscaleApp").mockImplementation(async () => {
    fixture.saved = null;
    fixture.app = null;
  });
}
const provider: Provider = {
  id: "tailscale",
  displayName: "Tailscale",
  category: "networking",
  authKind: "configuration",
  configured: false,
  docsUrl: "https://tailscale.com/docs/features/oauth-apps/device-provisioning",
  supportsRefresh: false,
  autoConfigurable: false,
  missingConfig: [],
  callbackUrl: null,
  scopes: [],
  operations: [],
  egress: {
    scheme: "https",
    authorities: ["api.tailscale.com"],
    pathPrefixes: [],
  },
};
export function mount() {
  return render(
    <TailscalePanels
      provider={provider}
      connection={null}
      online
      onChanged={fixture.changed}
      onFlash={fixture.flash}
    />,
  );
}
export async function register() {
  fireEvent.click(screen.getByText("Direct API registration"));
  fireEvent.change(await screen.findByLabelText("Admin API access token"), {
    target: { value: "fixture-admin" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Register app with Tailscale" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Register app with Tailscale" }),
  );
  await screen.findByLabelText("Registered client ID");
  fireEvent.click(screen.getByText("Direct API device authorization"));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Authorize a device with Tailscale" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}
export function resetFixture() {
  bindPorts();
  fixture.saved = null;
  fixture.app = null;
  fixture.locks.clear();
  fixture.changes.clear();
  fixture.active = true;
  fixture.guest = false;
  fixture.changed.mockReset();
  fixture.flash.mockReset();
  fixture.fetch.mockReset();
  fixture.authorize.mockReset();
  fixture.fetch.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/oauth-apps")) {
      const registration = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        id: "generated-operator-id",
        name: registration.name,
        clientSecret: "private-generated-app-secret",
        redirectURIs: registration.redirectUris,
        scopes: registration.scopes,
      });
    }
    if (path.endsWith("/oauth/token"))
      return Response.json({
        access_token: "issued-one-use-device-key",
        token_type: "Bearer",
        expires_in: 3600,
      });
    return Response.json(fixture.app);
  });
  fixture.authorize.mockImplementation(async (href) => {
    const url = new URL(href);
    return new URLSearchParams({
      native_state: url.searchParams.get("state") ?? "",
      native_code: "consent-code",
    }).toString();
  });
}
export function closeFixture() {
  cleanup();
  vi.restoreAllMocks();
}
