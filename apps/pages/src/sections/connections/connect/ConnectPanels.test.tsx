import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { applyConnectCallbackBase } from "@opensesame/app-core/lib/connect-callback.js";
import { initialDraftState } from "@opensesame/app-core/lib/connect-draft.js";
import {
  connectPlan,
  connectPlans,
  isConnectable,
} from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
import { forgetDeviceConnectors } from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { saveSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../../bindings/identity.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { isIdentityConnectionProvider } from "../identity/IdentityConnectionPanels.js";
import { ConnectPanels } from "./ConnectPanels.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import {
  activateNativePanelRuntime,
  expectNativePanel,
} from "./connect-panels.test-support.js";

Object.assign(identityHookSeams, {
  useIdentitySession: () => ({ principalId: "prn_person" }),
});
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], tomb: "", status: "locked" }),
});

const KEY = "k".repeat(40);
let runtime: Awaited<ReturnType<typeof activateNativePanelRuntime>>;

function provider(id: string): Provider {
  // Match the merged catalog used by Connections.
  const found = mergeVercelCatalog(getBundledProviders()).find(
    (row) => row.id === id,
  );
  if (!found) throw new Error(`${id} not in catalog`);
  return found;
}

function connectConnection(id: string): Connection {
  return {
    connectionId: "scl_1",
    connectionRef: "connect://resend/wedding",
    logicalName: "resend/wedding",
    displayName: "wedding-resend",
    providerId: id,
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "",
    projectId: null,
    ownerKind: "organization",
    shareability: "delegable",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "",
    updatedAt: "",
  };
}

function draw(id: string, connection: Connection | null = null) {
  const onFlash = vi.fn();
  render(
    <ConnectPanels
      provider={provider(id)}
      connection={connection}
      online
      onFlash={onFlash}
      onChanged={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  return onFlash;
}

function reply(body: JsonValue) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  runtime = await activateNativePanelRuntime();
  setVercelConnectAuth({ token: "vercel_token" });
});

afterEach(() => {
  cleanup();
  runtime.activation.dispose();
  forgetDeviceConnectors();
  vi.unstubAllGlobals();
  setVercelConnectAuth(null);
  applyConnectCallbackBase(undefined);
});

describe("user-token keys are drawn only where they can act (ADR 0158)", () => {
  it("draws no Test key in direct-token mode, where there is no relay to prove through", () => {
    draw("resend", connectConnection("resend"));
    expect(
      screen.queryByRole("button", { name: "Test user token" }),
    ).toBeNull();
  });

  it("draws the Test key once a relay and its manage key are held", () => {
    applyConnectCallbackBase("https://relay.test");
    setVercelConnectAuth({ token: "", manageKey: KEY });
    draw("resend", connectConnection("resend"));
    expect(
      screen.getByRole("button", { name: "Test user token" }),
    ).toBeTruthy();
  });
});

describe("no connector page is blank", () => {
  const ids = connectPlans()
    .filter(isConnectable)
    .map((plan) => plan.id)
    .filter((id) => id !== "github");

  it.each(ids)(
    "%s opens its own configuration or explicit browser refusal",
    (id) => {
      draw(id);
      expect(runtime.fetch).not.toHaveBeenCalled();
      const identity = isIdentityConnectionProvider(id);
      if (identity || isAiConnectionProvider(id)) {
        const form = within(
          screen.getByRole("region", {
            name: identity ? "Identity configuration" : "AI configuration",
          }),
        );
        expect(
          form.getByRole("button", {
            name: identity ? "Save identity connection" : "Save AI connection",
          }),
        ).toBeTruthy();
        expect(
          form.getByLabelText(identity ? "Protocol" : "API family"),
        ).toBeTruthy();
        return;
      }
      const panel = screen.getByRole("region", { name: "Connector" });
      const descriptor = nativeSettingsDescriptor(provider(id));
      if (!descriptor) throw new Error(`${id} has no native descriptor`);
      expectNativePanel(panel, descriptor, runtime.fetch);
    },
  );
});

describe("credential custody", () => {
  it("withholds a compiled token form without a genuine vault session", () => {
    const genuine = vi
      .spyOn(vaultStore, "isGenuineSession")
      .mockReturnValue(false);
    try {
      expect(
        nativeSettingsDescriptor(provider("github"))?.methods[0]?.available,
      ).toBe(false);
    } finally {
      genuine.mockRestore();
    }
  });
});

describe("moving between connectors", () => {
  it("starts each connector's form from its own plan", async () => {
    const view = render(
      <ConnectPanels
        provider={provider("algolia")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.queryByLabelText("Connector name")).toBeNull();
    await userEvent.type(
      screen.getByLabelText("Algolia API key"),
      "entered-only",
    );
    await userEvent.type(screen.getByLabelText("Application ID"), "first-app");
    view.rerender(
      <ConnectPanels
        provider={provider("gemini")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Connector name")).toBeNull();
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(screen.queryByLabelText("Application ID")).toBeNull();
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
});

describe("Linear configuration", () => {
  it("defaults to Linear MCP authorization without a Vercel credential or app registration", async () => {
    setVercelConnectAuth(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    draw("linear");
    expect(screen.queryByLabelText("Vercel access token")).toBeNull();
    expect(screen.queryByLabelText("Team ID")).toBeNull();
    expect(screen.queryByLabelText("Project ID")).toBeNull();
    expect(screen.queryByRole("region", { name: "Vercel Connect" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign in to Linear" }),
    ).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Managed" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Bring Your Own" })).toBeNull();
    expect(screen.queryByLabelText("Linear OAuth client ID")).toBeNull();
    expect(screen.getByLabelText("MCP permissions").textContent).toContain(
      "1 selected",
    );
    await userEvent.click(screen.getByLabelText("MCP permissions"));
    expect(screen.getByRole("checkbox", { name: "read" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "write" })).toHaveProperty(
      "checked",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an existing specialized Linear connector on its legacy custody page", async () => {
    const plan = connectPlan("linear");
    if (!plan) throw new Error("Linear plan required");
    const state = initialDraftState(plan, "api-key");
    const saved = await saveSelfHostedConnector(
      plan,
      { ...state, name: "Linear legacy", key: "lin_api_test-only" },
      {
        mode: "byo",
        workspace: "test-workspace",
        appScopes: [],
        userScopes: [],
        webhookResourceTypes: [],
        icon: "",
      },
    );
    draw("linear", saved);
    expect(screen.getByLabelText("Linear API key")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Sign in to Linear" }),
    ).toBeNull();
    expect(screen.getByText("Linear saved connection actions")).toBeTruthy();
  });

  it("keeps the existing OAuth app and API key route in an advanced disclosure", async () => {
    setVercelConnectAuth(null);
    draw("linear");
    expect(screen.queryByLabelText("Linear API key")).toBeNull();
    await userEvent.click(
      screen.getByText("Advanced: existing OAuth app or API key"),
    );
    expect(
      screen.getByRole("radio", { name: "Bring Your Own" }),
    ).toHaveProperty("checked", true);
    expect(screen.getByLabelText("Linear OAuth client ID")).toBeTruthy();
    expect(screen.getByLabelText("Redirect URI")).toHaveProperty(
      "readOnly",
      true,
    );
    expect(screen.queryByLabelText("Client secret")).toBeNull();
    expect(screen.queryByLabelText("Authorization endpoint")).toBeNull();
    expect(
      screen.getByText("Create a prefilled Linear OAuth app"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "API key" }));
    expect(screen.getByLabelText("Linear API key")).toHaveProperty(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Verify and connect Linear" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByLabelText("API")).toBeNull();
    expect(screen.queryByLabelText("App Scopes")).toBeNull();
    expect(screen.queryByText(/Vercel/)).toBeNull();
  });
});

describe("a person's token", () => {
  it("authorizes as the signed-in person and proves the token without seeing it", async () => {
    applyConnectCallbackBase("https://relay.test");
    setVercelConnectAuth({ token: "", manageKey: KEY });
    const calls: { url: string; body: JsonObject }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        if (url.endsWith("/api/connect/connector/read")) {
          return reply({
            connector: {
              id: "scl_1",
              uid: "resend/wedding",
              type: "oauth",
              data: {},
            },
          });
        }
        if (url.endsWith("/api/connect/token-check")) {
          return reply({
            subject: "user",
            expiresAt: 1_900_000_000_000,
            scopes: ["emails:send"],
            fingerprint: "0123456789ab",
            verified: { status: 200, ok: true, account: "wedding.example" },
          });
        }
        return reply({});
      },
    );
    draw("resend", connectConnection("resend"));
    await userEvent.click(
      screen.getByRole("button", { name: "Test user token" }),
    );
    await waitFor(() =>
      expect(screen.getByText("sha256:0123456789ab…")).toBeTruthy(),
    );
    expect(screen.getByText("wedding.example")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Token accepted" })).toBeTruthy();
    const check = calls.find((call) =>
      call.url.endsWith("/api/connect/token-check"),
    );
    expect(check?.body.subject).toEqual({ type: "user", id: "prn_person" });
  });

  it("keeps a token proof with the connector it was made for", async () => {
    applyConnectCallbackBase("https://relay.test");
    setVercelConnectAuth({ token: "", manageKey: KEY });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/connect/connector/read")) {
        return reply({ connector: { id: "scl_1", type: "oauth", data: {} } });
      }
      if (url.endsWith("/api/connect/token-check")) {
        return reply({
          subject: "user",
          fingerprint: "0123456789ab",
          verified: { status: 200, ok: true, account: "alice@resend" },
        });
      }
      return reply({});
    });
    const first = connectConnection("resend");
    const view = render(
      <ConnectPanels
        provider={provider("resend")}
        connection={first}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
      { wrapper: MemoryRouter },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Test user token" }),
    );
    await waitFor(() => expect(screen.getByText("alice@resend")).toBeTruthy());
    view.rerender(
      <ConnectPanels
        provider={provider("resend")}
        connection={{ ...first, connectionId: "scl_2" }}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText("alice@resend")).toBeNull();
    expect(screen.queryByText("sha256:0123456789ab…")).toBeNull();
  });
});
