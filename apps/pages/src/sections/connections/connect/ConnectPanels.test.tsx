/** @vitest-environment jsdom */
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
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
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
  vi.unstubAllGlobals();
  setVercelConnectAuth(null);
  applyConnectCallbackBase(undefined);
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
      within(panel).getByRole("button", { name: "Create connector" }),
    ).toBeTruthy();
    expect(within(panel).getByLabelText("Name")).toHaveProperty(
      "value",
      connectPlan(id)?.name,
    );
    expect(within(panel).getByLabelText("UID")).toHaveProperty(
      "value",
      `${id}/default`,
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
    await userEvent.click(screen.getByRole("radio", { name: "OAuth" }));
    view.rerender(
      <ConnectPanels
        provider={provider("okta")}
        connection={null}
        online
        onFlash={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Okta");
    expect(screen.getByLabelText("UID")).toHaveProperty(
      "value",
      "okta/default",
    );
  });
});

describe("Resend", () => {
  it("prefills the OAuth server from what we know and lets Vercel register the client", async () => {
    draw("resend");
    await userEvent.click(screen.getByRole("radio", { name: "OAuth" }));
    expect(screen.getByLabelText("Authorization endpoint")).toHaveProperty(
      "value",
      "https://api.resend.com/oauth/authorize",
    );
    expect(screen.getByLabelText("Token endpoint")).toHaveProperty(
      "value",
      "https://api.resend.com/oauth/token",
    );
    expect(screen.getByLabelText("Client ID (optional)")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Create connector" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("asks where connectors live when nothing is configured, instead of a dead end", () => {
    setVercelConnectAuth(null);
    draw("resend");
    expect(screen.getByRole("region", { name: "Vercel Connect" })).toBeTruthy();
    expect(screen.getByLabelText("Vercel access token")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Create connector" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("asks for the relay's management key on a relay deployment", () => {
    setVercelConnectAuth(null);
    applyConnectCallbackBase("https://relay.test");
    draw("resend");
    expect(screen.getByLabelText("Relay management key")).toBeTruthy();
  });
});

describe("Linear", () => {
  it("creates the OAuth connector whole, with the scopes a person picks", async () => {
    // Pages no longer speaks Host (ADR 0128): the connector is created on
    // Vercel Connect with its OAuth server, client and scopes (ADR 0146).
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/v1/connect/connectors"))
          sent.push(String(init?.body));
        return reply({
          connector: { id: "scl_1", uid: "linear/linear", service: "linear" },
        });
      },
    );
    draw("linear");
    await userEvent.click(screen.getByRole("radio", { name: "OAuth" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /^write/ }));
    await userEvent.type(screen.getByLabelText("Client ID"), "lin_client");
    await userEvent.type(screen.getByLabelText("Client secret"), "lin_secret");
    await userEvent.click(
      screen.getByRole("button", { name: "Create connector" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      service: "linear",
      type: "oauth",
      data: {
        clientId: "lin_client",
        clientSecret: "lin_secret",
        serverConfig: {
          authorization_endpoint: "https://linear.app/oauth/authorize",
          token_endpoint: "https://api.linear.app/oauth/token",
        },
        userAuthorization: { enabled: true, scopes: ["read", "write"] },
      },
    });
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
});
