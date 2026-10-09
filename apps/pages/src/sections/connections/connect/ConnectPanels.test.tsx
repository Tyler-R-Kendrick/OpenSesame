import { applyConnectCallbackBase } from "@opensesame/app-core/lib/connect-callback.js";
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
import {
  forgetDeviceConnectors,
  listDeviceConnections,
} from "@opensesame/app-core/lib/device-connectors.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import { readSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../../bindings/identity.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { ConnectPanels } from "./ConnectPanels.js";

Object.assign(identityHookSeams, {
  useIdentitySession: () => ({ principalId: "prn_person" }),
});
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], tomb: "", status: "locked" }),
});

const KEY = "k".repeat(40);

function provider(id: string): Provider {
  // Every row the Connections page lists: Connect's own, then the bundled
  // rows that keep their road and get Connect beside it.
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
  );
  return onFlash;
}

function reply(body: JsonValue) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setVercelConnectAuth({ token: "vercel_token" });
});

afterEach(() => {
  cleanup();
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

  it.each(ids)("%s opens filled in, with a way to create it", (id) => {
    draw(id);
    const panel = screen.getByRole("region", { name: "Connector" });
    expect(
      within(panel).getByRole("button", { name: "Create Connector" }),
    ).toBeTruthy();
    expect(within(panel).getByLabelText("Connector Name")).toHaveProperty(
      "value",
      connectPlan(id)?.name,
    );
  });
});

describe("moving between connectors", () => {
  it("starts each connector's form from its own plan", async () => {
    const view = render(
      <ConnectPanels
        provider={provider("resend")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "API key" }));
    view.rerender(
      <ConnectPanels
        provider={provider("okta")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Connector Name")).toHaveProperty(
      "value",
      "Okta",
    );
  });
});

describe("self-hosted provider configuration", () => {
  it("shows Linear configuration without a Vercel credential or relay", async () => {
    setVercelConnectAuth(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    draw("linear");
    expect(screen.queryByLabelText("Vercel access token")).toBeNull();
    expect(screen.queryByLabelText("Team ID")).toBeNull();
    expect(screen.queryByLabelText("Project ID")).toBeNull();
    expect(screen.queryByRole("region", { name: "Vercel Connect" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Managed" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("radio", { name: "Bring Your Own" })).toBeTruthy();
    expect(screen.getByLabelText("Select a Linear workspace")).toBeTruthy();
    expect(screen.getByLabelText("Icon")).toHaveProperty(
      "accept",
      "image/png,image/jpeg",
    );
    expect(screen.getByLabelText("App Scopes").textContent).toContain(
      "4 selected",
    );
    expect(screen.getByLabelText("User Scopes").textContent).toContain(
      "2 selected",
    );
    expect(
      screen.getByLabelText("Webhook Resource Types").textContent,
    ).toContain("2 selected");
    await userEvent.click(
      screen.getByRole("radio", { name: "Bring Your Own" }),
    );
    expect(screen.getByLabelText("Client ID")).toBeTruthy();
    expect(screen.getByLabelText("Authorization endpoint")).toHaveProperty(
      "value",
      "https://linear.app/oauth/authorize",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stores Linear settings locally, retains selections, and keeps secrets out of readback", async () => {
    setVercelConnectAuth(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const onFlash = draw("linear");
    await userEvent.type(
      screen.getByLabelText("Select a Linear workspace"),
      "quickdeploy-ai",
    );
    await userEvent.click(screen.getByText("Linear OAuth application"));
    await userEvent.type(screen.getByLabelText("Client ID"), "lin_client");
    await userEvent.type(screen.getByLabelText("Client secret"), "lin_secret");
    await userEvent.click(screen.getByLabelText("Webhook Resource Types"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Project" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create Connector" }),
    );
    await waitFor(() => expect(listDeviceConnections()).toHaveLength(1));
    const row = listDeviceConnections()[0];
    expect(row?.status).toBe("pending");
    expect(row?.grantedScopes).toEqual([]);
    const saved = readSelfHostedConnector(row?.connectionId ?? "");
    expect(saved?.options).toMatchObject({
      workspace: "quickdeploy-ai",
      appScopes: ["read", "write", "issues:create", "comments:create"],
      userScopes: ["read", "write"],
      webhookResourceTypes: ["Issue", "Comment", "Project"],
    });
    expect(saved?.state.oauth.clientSecret).toBe("");
    expect(saved?.hasCredential).toBe(true);
    expect(onFlash).toHaveBeenCalledWith({
      tone: kvDurability() === "memory" ? "warn" : "ok",
      text:
        kvDurability() === "memory"
          ? "Linear configuration is kept for this session."
          : "Linear configuration is saved on this device.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "");
    await userEvent.click(
      screen.getByRole("button", { name: "Save connector" }),
    );
    expect(listDeviceConnections()).toHaveLength(1);
  });

  it("asks for the selected provider key, never a Vercel key", async () => {
    setVercelConnectAuth(null);
    draw("linear");
    await userEvent.click(
      screen.getByRole("radio", { name: "Bring Your Own" }),
    );
    await userEvent.click(screen.getByRole("radio", { name: "API key" }));
    expect(
      screen
        .getAllByLabelText("API key")
        .find((element) => element.getAttribute("type") === "password"),
    ).toBeTruthy();
    expect(screen.getByLabelText("API")).toHaveProperty(
      "value",
      "https://api.linear.app",
    );
    expect(screen.queryByText(/Vercel/)).toBeNull();
  });

  it("starts every supported provider from its own preset without deployment credentials", () => {
    setVercelConnectAuth(null);
    draw("resend");
    expect(screen.getByRole("region", { name: "Connector" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create Connector" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Relay management key")).toBeNull();
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
