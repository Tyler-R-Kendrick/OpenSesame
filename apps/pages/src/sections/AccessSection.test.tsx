import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation, DelegationOffer } from "../lib/access.js";
import type { Connection } from "../lib/connections.js";
import { kvDelete } from "../lib/kv.js";
import type { SecretItem } from "../lib/vault/model.js";

const online = vi.hoisted(() => ({ value: true }));
const session: { current: { principalId: string } | null } = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const identityJson = vi.hoisted(() => vi.fn());
const identityFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "../lib/identity.js";
Object.assign(identitySeams, {
  hostBase: () => "http://127.0.0.1:8787",
  identityBase: () => "http://127.0.0.1:8788",
  identityJson,
  identityFetch,
  useIdentitySession: () => session.current,
});

import { useOnlineSeams } from "../lib/use-online.js";
Object.assign(useOnlineSeams, { useOnline: () => online.value });

const vault: {
  current: { items: SecretItem[]; status: "empty" | "locked" | "unlocked" };
} = vi.hoisted(() => ({
  current: { items: [], status: "unlocked" },
}));

import { vaultHooksSeams } from "../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, { useVault: () => vault.current });

const access = vi.hoisted(() => ({
  listRelayRequests: vi.fn(),
  approveRelayRequest: vi.fn(),
  denyRelayRequest: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  terminateTask: vi.fn(),
  listMyOffers: vi.fn(),
  claimDelegation: vi.fn(),
  listDelegations: vi.fn(),
  revokeDelegation: vi.fn(),
  narrowDelegation: vi.fn(),
  mintOffer: vi.fn(),
  revokeOffer: vi.fn(),
}));

import { AccessError, accessSeams } from "../lib/access.js";
Object.assign(accessSeams, access);

const connections = vi.hoisted(() => ({
  listConnections: vi.fn(),
  updateConnectionPolicy: vi.fn(),
  bindConnection: vi.fn(),
  unbindConnection: vi.fn(),
}));

import { connectionSeams } from "../lib/connections.js";
Object.assign(connectionSeams, connections);

import { AccessSection } from "./AccessSection.js";

function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
  return {
    id: "itm_s1",
    kind: "secret",
    name: "Deploy hook",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    value: "whsec_1",
    ceiling: [],
    grantees: [],
    connectionRef: "",
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: "conn_1",
    connectionRef: "conn/github/pat",
    logicalName: "github-pat",
    displayName: "GitHub PAT",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "org_1",
    projectId: null,
    ownerKind: "user",
    shareability: "delegable",
    requestedScopes: [],
    grantedScopes: ["repo"],
    accountLabel: null,
    expiresAt: null,
    refreshable: true,
    lastRefreshedAt: null,
    maxInvokeLevel: 2,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: "dlg_1",
    offerId: "dlgo_1",
    connectionId: "conn_1",
    claimantSubject: "agt_bot",
    grantId: "grt_1",
    executionMode: "broker",
    actions: ["repository.read"],
    resources: ["*"],
    expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null,
    ...overrides,
  };
}

function makeRelayRequest() {
  return {
    id: "rreq_1",
    delegationId: "dlg_1",
    connectionId: "conn_1",
    operation: "repository.read",
    resource: "repo:acme/catalog",
    parameters: { path: "/README.md" },
    requestDigest: "sha256:abc123",
    state: "pending_approval",
  };
}

function makeTaskRun() {
  return {
    taskRunId: "task_1",
    stateVersion: 7,
    status: "active",
    principalId: "prn_op",
  };
}

function makeOffer(overrides: Partial<DelegationOffer> = {}): DelegationOffer {
  return {
    id: "dlgo_1",
    state: "pending",
    manifestDigest: "sha256:manifest",
    expiresAt: "2099-01-01T00:00:00Z",
    items: [
      {
        id: "dlgi_1",
        connectionId: "conn_1",
        providerId: "github",
        displayName: "GitHub PAT",
        actions: ["repository.read"],
        resources: ["*"],
        expiresInSeconds: 3600,
        executionMode: "broker",
        required: true,
        dependencies: [],
      },
    ],
    ...overrides,
  };
}

function makeMinted() {
  return {
    offer: makeOffer(),
    claimToken: "osc_dlg_x.y",
    userCode: "AAAA-BBBB",
  };
}

function renderAccess() {
  return render(
    <MemoryRouter>
      <AccessSection />
    </MemoryRouter>,
  );
}

async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
}

function jsonResponse(body: JsonObject, ok = true, status = 200) {
  return overlapCast({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

const clientAlpha = {
  id: "cli_alpha",
  admissionMode: "pre_registered",
  displayName: "alpha.example.com",
  redirectUris: ["https://alpha.example.com/callback"],
  sectorIdentifier: "https://alpha.example.com",
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid", "profile"],
  allowedResources: [],
  state: "active",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

/** Identity-plane defaults: the GET list answers with `rows`, mutations 500. */
function mockClients(rows: Array<typeof clientAlpha>) {
  identityFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/v1/oauth/clients" && init?.method === "POST") {
      return Promise.resolve(jsonResponse({}, false, 500));
    }
    if (path === "/v1/oauth/clients") {
      return Promise.resolve(jsonResponse({ clients: rows }));
    }
    if (path.startsWith("/v1/audit/events")) {
      return Promise.resolve(jsonResponse({ events: [] }));
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

describe("AccessSection", () => {
  beforeEach(() => {
    vault.current = { items: [], status: "unlocked" };
    session.current = { principalId: "prn_op" };
    online.value = true;
    identityJson.mockResolvedValue({ events: [] });
    mockClients([]);
    kvDelete("site-broker.consents.v1");
    kvDelete("site-broker.policy.v1");

    access.listRelayRequests.mockResolvedValue([]);
    access.approveRelayRequest.mockResolvedValue({
      id: "rreq_1",
      state: "approved",
    });
    access.denyRelayRequest.mockResolvedValue({
      id: "rreq_1",
      state: "denied",
    });
    access.listTasks.mockResolvedValue([]);
    access.getTask.mockResolvedValue({
      ...makeTaskRun(),
      capabilityCeiling: {
        capabilities: [
          { action: "http.post", resource: "https://a.example.com" },
        ],
      },
      currentCapabilities: [
        { action: "http.post", resource: "https://a.example.com" },
      ],
    });
    access.terminateTask.mockResolvedValue({
      taskRunId: "task_1",
      stateVersion: 8,
      status: "cancelled",
      principalId: "prn_op",
    });
    access.listMyOffers.mockResolvedValue([]);
    access.listDelegations.mockResolvedValue([]);
    access.revokeDelegation.mockResolvedValue(undefined);
    access.narrowDelegation.mockResolvedValue(makeDelegation());
    access.mintOffer.mockResolvedValue(makeMinted());
    access.revokeOffer.mockResolvedValue(undefined);

    connections.listConnections.mockResolvedValue([]);
    connections.updateConnectionPolicy.mockResolvedValue(makeConnection());
    connections.bindConnection.mockResolvedValue(makeConnection());
    connections.unbindConnection.mockResolvedValue(makeConnection());

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows Grants as the default tab and mounts one tab at a time", async () => {
    renderAccess();
    for (const name of [
      "Grants",
      "Requests",
      "Sessions",
      "Resources",
      "Policies",
    ]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(
      screen.getByRole("tab", { name: "Grants" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(await screen.findByText("No active grants.")).toBeTruthy();

    await openTab("Requests");
    expect(
      await screen.findByRole("heading", { name: "Requests" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Grants" })).toBeNull();

    await openTab("Sessions");
    expect(
      await screen.findByRole("heading", { name: "Sessions" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Requests" })).toBeNull();

    await openTab("Resources");
    expect(
      await screen.findByRole("heading", { name: "Resources" }),
    ).toBeTruthy();

    await openTab("Policies");
    expect(
      await screen.findByRole("heading", { name: "Policies" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Resources" })).toBeNull();
  });

  it("renders delegation rows with the connection name resolved", async () => {
    access.listDelegations.mockResolvedValue([makeDelegation()]);
    connections.listConnections.mockResolvedValue([makeConnection()]);
    renderAccess();
    expect(await screen.findByText("agt_bot")).toBeTruthy();
    expect(screen.getByText("GitHub PAT")).toBeTruthy();
    expect(screen.getByText("repository.read")).toBeTruthy();
    expect(screen.getByText("broker")).toBeTruthy();
    expect(screen.getByText(/^in /)).toBeTruthy();
  });

  it("hides revoked delegations from the table", async () => {
    access.listDelegations.mockResolvedValue([
      makeDelegation({ revokedAt: "2026-08-01T00:00:00Z" }),
    ]);
    renderAccess();
    expect(await screen.findByText("No active grants.")).toBeTruthy();
    expect(screen.queryByText("agt_bot")).toBeNull();
  });

  it("revokes a grant after a confirm", async () => {
    access.listDelegations.mockResolvedValue([makeDelegation()]);
    renderAccess();
    await screen.findByText("agt_bot");
    await userEvent.click(screen.getByRole("button", { name: /^Revoke$/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Revoke grant/i }),
    );
    await waitFor(() =>
      expect(access.revokeDelegation).toHaveBeenCalledWith("dlg_1"),
    );
    expect(await screen.findByText(/Grant to agt_bot revoked/)).toBeTruthy();
  });

  it("narrows a grant, omitting fields left as granted", async () => {
    access.listDelegations.mockResolvedValue([makeDelegation()]);
    renderAccess();
    await screen.findByText("agt_bot");
    await userEvent.click(screen.getByRole("button", { name: /^Narrow$/i }));
    const resources = screen.getByLabelText(/^Resources$/i);
    await userEvent.clear(resources);
    await userEvent.type(screen.getByLabelText(/Shorter expiry/i), "600");
    await userEvent.click(screen.getByRole("button", { name: /^Apply$/i }));
    await waitFor(() =>
      expect(access.narrowDelegation).toHaveBeenCalledWith("dlg_1", {
        actions: ["repository.read"],
        expiresInSeconds: 600,
      }),
    );
    expect(await screen.findByText("Grant narrowed.")).toBeTruthy();
  });

  it("runs the grant ceremony for a connection target through to the code card", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );

    // Step 1: target picker, two groups.
    expect(
      await screen.findByRole("heading", { name: "Connections" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Secrets" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /GitHub PAT/ }));

    // Step 2: who — a connection target defaults to "anyone with the code".
    expect(
      await screen.findByRole("button", { name: "Specific identities" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Step 3: scope.
    await userEvent.type(
      screen.getByLabelText(/^Actions$/i),
      "repository.read",
    );
    await userEvent.type(screen.getByLabelText(/^Resources$/i), "*");
    await userEvent.click(screen.getByRole("button", { name: "8h" }));
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Step 4: the review humanizes the grant before minting.
    expect(await screen.findByText("8 hours")).toBeTruthy();
    expect(screen.getByText("Anyone with the code")).toBeTruthy();

    // Step 5: mint posts the exact request, and nothing is bound.
    await userEvent.click(
      await screen.findByRole("button", { name: /Mint offer/i }),
    );
    await waitFor(() =>
      expect(access.mintOffer).toHaveBeenCalledWith({
        items: [
          {
            connectionId: "conn_1",
            actions: ["repository.read"],
            resources: ["*"],
            expiresInSeconds: 28_800,
            executionMode: "broker",
          },
        ],
      }),
    );
    expect(connections.bindConnection).not.toHaveBeenCalled();

    // Step 4: the code card shows token and user code with copy affordances.
    expect(await screen.findByText("osc_dlg_x.y")).toBeTruthy();
    expect(screen.getByText("AAAA-BBBB")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Done$/ })).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Copy claim token/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("osc_dlg_x.y");

    await userEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    expect(await screen.findByText("No active grants.")).toBeTruthy();
  });

  it("assigns the grant to an agent and binds it on mint", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    connections.bindConnection.mockResolvedValue(makeConnection());
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /GitHub PAT/ }),
    );

    // Who — assign to an agent.
    await userEvent.click(
      await screen.findByRole("button", { name: "Specific identities" }),
    );
    await userEvent.type(screen.getByLabelText(/^Identity id$/i), "deploy-bot");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(await screen.findByText("agent:deploy-bot")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Scope, then review names the recipient.
    await userEvent.type(
      screen.getByLabelText(/^Actions$/i),
      "repository.read",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByText("agent:deploy-bot")).toBeTruthy();
    expect(screen.getByText(/will be bound/)).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("button", { name: /Mint offer/i }),
    );
    await waitFor(() =>
      expect(connections.bindConnection).toHaveBeenCalledWith("conn_1", {
        targetKind: "agent",
        targetId: "deploy-bot",
      }),
    );
    // The code card is addressed and confirms the binding.
    expect(
      (await screen.findAllByText("agent:deploy-bot")).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText("Bound to the connection.")).toBeTruthy();
  });

  it("blocks an agent outside a secret's grantees", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    connections.bindConnection.mockResolvedValue(makeConnection());
    vault.current = {
      status: "unlocked",
      items: [
        makeSecret({
          name: "Deploy hook",
          connectionRef: "conn/github/pat",
          grantees: ["agt_bot"],
          ceiling: [{ id: "g1", action: "http.post", resource: "*" }],
        }),
      ],
    };
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Deploy hook/ }),
    );

    // Who — the secret's grantees prefill the recipient list.
    expect(await screen.findByText("agent:agt_bot")).toBeTruthy();

    // An agent the secret does not permit is refused at Add.
    await userEvent.type(screen.getByLabelText(/^Identity id$/i), "evil-bot");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(
      await screen.findByText(/Not in this secret's grantees/),
    ).toBeTruthy();
    expect(screen.queryByText("agent:evil-bot")).toBeNull();

    // The permitted agent goes through and is bound on mint.
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /^Continue$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Mint offer/i }),
    );
    await waitFor(() =>
      expect(connections.bindConnection).toHaveBeenCalledWith("conn_1", {
        targetKind: "agent",
        targetId: "agt_bot",
      }),
    );
    expect(connections.bindConnection).toHaveBeenCalledTimes(1);
  });

  it("binds every recipient when a grant names several identities", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    connections.bindConnection.mockResolvedValue(makeConnection());
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /GitHub PAT/ }),
    );

    // Who — an agent and a device.
    await userEvent.click(
      await screen.findByRole("button", { name: "Specific identities" }),
    );
    await userEvent.type(screen.getByLabelText(/^Identity id$/i), "deploy-bot");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    await userEvent.selectOptions(screen.getByLabelText(/^Identity kind$/i), [
      "device",
    ]);
    await userEvent.type(screen.getByLabelText(/^Identity id$/i), "macbook-1");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(await screen.findByText("agent:deploy-bot")).toBeTruthy();
    expect(screen.getByText("device:macbook-1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Review lists both, and mint binds both.
    await userEvent.click(
      await screen.findByRole("button", { name: /^Continue$/i }),
    );
    expect(
      await screen.findByText("agent:deploy-bot, device:macbook-1"),
    ).toBeTruthy();
    await userEvent.click(
      await screen.findByRole("button", { name: /Mint offer/i }),
    );
    await waitFor(() =>
      expect(connections.bindConnection).toHaveBeenCalledTimes(2),
    );
    expect(connections.bindConnection).toHaveBeenCalledWith("conn_1", {
      targetKind: "agent",
      targetId: "deploy-bot",
    });
    expect(connections.bindConnection).toHaveBeenCalledWith("conn_1", {
      targetKind: "device",
      targetId: "macbook-1",
    });
    expect(await screen.findByText("Bound to the connection.")).toBeTruthy();
  });

  it("prefills a secret target from its ceiling and blocks widening", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    vault.current = {
      status: "unlocked",
      items: [
        makeSecret({
          name: "Deploy hook",
          connectionRef: "conn/github/pat",
          ceiling: [
            {
              id: "g1",
              action: "http.post",
              resource: "https://deploy.example.com",
            },
          ],
        }),
      ],
    };
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Deploy hook/ }),
    );
    // Who — this secret names no grantees, so it defaults to "anyone".
    await userEvent.click(
      await screen.findByRole("button", { name: /^Continue$/i }),
    );

    // Scope prefills from the ceiling, shown as read-only context.
    const actions = screen.getByLabelText(/^Actions$/i);
    const resources = screen.getByLabelText(/^Resources$/i);
    expect(actions).toHaveProperty("value", "http.post");
    expect(resources).toHaveProperty("value", "https://deploy.example.com");

    // Anything the ceiling does not imply is blocked.
    await userEvent.type(actions, ", evil.action");
    expect(await screen.findByText(/Outside the ceiling/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Continue$/i })).toHaveProperty(
      "disabled",
      true,
    );

    await userEvent.clear(actions);
    await userEvent.type(actions, "http.post");
    await userEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // The mint resolves the secret's connectionRef to the connection id.
    await userEvent.click(
      await screen.findByRole("button", { name: /Mint offer/i }),
    );
    await waitFor(() =>
      expect(access.mintOffer).toHaveBeenCalledWith({
        items: [
          {
            connectionId: "conn_1",
            actions: ["http.post"],
            resources: ["https://deploy.example.com"],
            expiresInSeconds: 3_600,
            executionMode: "broker",
          },
        ],
      }),
    );
    expect(await screen.findByText("AAAA-BBBB")).toBeTruthy();
  });

  it("blocks minting a secret whose reference no Host connection matches", async () => {
    vault.current = {
      status: "unlocked",
      items: [
        makeSecret({
          name: "Orphan",
          connectionRef: "conn/nowhere/none",
          ceiling: [{ id: "g1", action: "http.get", resource: "*" }],
        }),
      ],
    };
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Orphan/ }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Continue$/i }),
    );
    expect(await screen.findByText(/No Host connection matches/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Continue$/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says one line when the vault is locked", async () => {
    vault.current = { items: [], status: "locked" };
    renderAccess();
    await screen.findByText("No active grants.");
    await userEvent.click(
      screen.getByRole("button", { name: /^Grant access$/i }),
    );
    expect(
      await screen.findByText("Unlock the vault to grant secrets."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Secrets" })).toBeNull();
  });

  it("approves with the digest echoed, and a 404 collapses the row", async () => {
    access.listRelayRequests.mockResolvedValue([makeRelayRequest()]);
    renderAccess();
    await openTab("Requests");
    expect(await screen.findByText("repository.read")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Approve$/i }));
    await waitFor(() =>
      expect(access.approveRelayRequest).toHaveBeenCalledWith(
        "rreq_1",
        "sha256:abc123",
      ),
    );
    expect(
      await screen.findByText(/Approved — reviewed digest sha256:abc123/),
    ).toBeTruthy();

    access.approveRelayRequest.mockRejectedValueOnce(
      new AccessError(
        404,
        "not_found",
        "Already decided or lapsed — someone else got there, or the request expired. Reload the inbox.",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/i }));
    expect(await screen.findByText(/Already decided or lapsed/)).toBeTruthy();
    expect(screen.queryByText("repo:acme/catalog")).toBeNull();
  });

  it("lists my offers with state and revokes a pending one", async () => {
    access.listMyOffers.mockResolvedValue([
      makeOffer(),
      makeOffer({ id: "dlgo_2", state: "claimed" }),
    ]);
    renderAccess();
    await openTab("Requests");
    expect(await screen.findByText("dlgo_1")).toBeTruthy();
    expect(screen.getByText("claimed")).toBeTruthy();
    // Only the pending offer carries a Revoke action.
    expect(screen.getAllByRole("button", { name: /^Revoke$/i })).toHaveLength(
      1,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Revoke$/i }));
    await waitFor(() =>
      expect(access.revokeOffer).toHaveBeenCalledWith("dlgo_1"),
    );
    expect(await screen.findByText("Offer revoked.")).toBeTruthy();
  });

  it("shows the empty requests state", async () => {
    renderAccess();
    await openTab("Requests");
    expect(
      await screen.findByText("Nothing waiting for approval."),
    ).toBeTruthy();
  });

  it("lists task runs, expands the ceiling comparison, and terminates", async () => {
    access.listTasks.mockResolvedValue([makeTaskRun()]);
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("task_1")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    await waitFor(() => expect(access.getTask).toHaveBeenCalledWith("task_1"));
    expect(await screen.findByText("Held in full")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Terminate$/i }));
    await waitFor(() =>
      expect(access.terminateTask).toHaveBeenCalledWith("task_1", 7),
    );
    expect(await screen.findByText(/Task task_1 was terminated/)).toBeTruthy();
  });

  it("shows the empty sessions state", async () => {
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("No live sessions.")).toBeTruthy();
  });

  it("renders agent and connection receipts, not unrelated events", async () => {
    identityJson.mockResolvedValue({
      events: [
        {
          id: "evt_1",
          occurredAt: "2026-08-19T10:00:00Z",
          eventType: "agent.registered",
          outcome: "succeeded",
        },
        {
          id: "evt_2",
          occurredAt: "2026-08-19T10:01:00Z",
          eventType: "connection.invoked",
          outcome: "succeeded",
        },
        {
          id: "evt_3",
          occurredAt: "2026-08-19T10:02:00Z",
          eventType: "session.created",
          outcome: "succeeded",
        },
      ],
    });
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("agent.registered")).toBeTruthy();
    expect(screen.getByText("connection.invoked")).toBeTruthy();
    expect(screen.queryByText("session.created")).toBeNull();
  });

  it("renders terse resource rows and opens the ceremony preselected", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    vault.current = {
      status: "unlocked",
      items: [
        makeSecret({
          name: "Deploy hook",
          connectionRef: "conn/github/pat",
          ceiling: [
            {
              id: "g1",
              action: "http.post",
              resource: "https://deploy.example.com",
            },
          ],
        }),
      ],
    };
    renderAccess();
    await openTab("Resources");
    expect(await screen.findByText("GitHub PAT")).toBeTruthy();
    expect(screen.getAllByText("conn/github/pat")).toHaveLength(2);
    expect(screen.getByText("Deploy hook")).toBeTruthy();
    expect(screen.getByText("ceiling: 1")).toBeTruthy();
    // Values never render.
    expect(screen.queryByText("whsec_1")).toBeNull();

    const rows = screen.getAllByRole("button", { name: /^Grant access$/i });
    const first = rows[0];
    if (!first) throw new Error("expected a Grant access button");
    await userEvent.click(first);
    // The ceremony opens preselected on the Who step, scope one click away.
    expect(
      await screen.findByRole("button", { name: "Specific identities" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mint offer/i })).toBeNull();
    expect(screen.getByRole("heading", { name: "Grant access" })).toBeTruthy();
  });

  it("drills from a resource row into the Policies tab", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    renderAccess();
    await openTab("Resources");
    await screen.findByText("GitHub PAT");
    await userEvent.click(screen.getByRole("button", { name: /^Policy$/i }));
    expect(await screen.findByLabelText(/^Delegation$/i)).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Policies" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("shows the resources empty state as one line with a link", async () => {
    renderAccess();
    await openTab("Resources");
    expect(
      await screen.findByText(
        /Nothing to grant yet — connect a service or add a secret./,
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Connections" });
    expect(link.getAttribute("href")).toBe("/connections");
  });

  it("walks the Policies picker into a drill-in and back", async () => {
    connections.listConnections.mockResolvedValue([
      makeConnection(),
      makeConnection({
        connectionId: "conn_2",
        connectionRef: "conn/aws/s3",
        displayName: "S3 bucket",
        providerId: "aws",
      }),
    ]);
    renderAccess();
    await openTab("Policies");
    const row = await screen.findByText("S3 bucket");
    const item = row.closest("li");
    if (!item) throw new Error("expected a list row");
    await userEvent.click(
      within(item).getByRole("button", { name: /^Policy$/i }),
    );

    // The drill-in edits that one connection only.
    await userEvent.click(
      await screen.findByRole("button", { name: /Save rules/i }),
    );
    await waitFor(() =>
      expect(connections.updateConnectionPolicy).toHaveBeenCalledWith(
        "conn_2",
        { shareability: "delegable", maxInvokeLevel: 2 },
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: /← Policies/i }));
    expect(await screen.findByText("S3 bucket")).toBeTruthy();
    expect(screen.queryByLabelText(/^Delegation$/i)).toBeNull();
  });

  it("carries no Agent wording and no agent registration form", async () => {
    const { container } = renderAccess();
    await screen.findByText("No active grants.");
    for (const name of [
      "Requests",
      "Sessions",
      "Resources",
      "Policies",
      "Grants",
    ]) {
      await openTab(name);
      await waitFor(() =>
        expect(container.textContent ?? "").not.toMatch(/\bAgents?\b/),
      );
    }
    // Site registration lives in Resources now; agent registration stays out.
    expect(
      screen.queryByText(/Register an? (agent|service account)/i),
    ).toBeNull();
  });
});

describe("AccessSection sites", () => {
  beforeEach(() => {
    vault.current = { items: [], status: "unlocked" };
    session.current = { principalId: "prn_op" };
    online.value = true;
    identityJson.mockResolvedValue({ events: [] });
    mockClients([]);
    kvDelete("site-broker.consents.v1");
    kvDelete("site-broker.policy.v1");

    access.listRelayRequests.mockResolvedValue([]);
    access.listTasks.mockResolvedValue([]);
    access.listMyOffers.mockResolvedValue([]);
    access.listDelegations.mockResolvedValue([]);
    connections.listConnections.mockResolvedValue([]);

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists site rows in Resources and drills in from Manage", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    expect(await screen.findByText("alpha.example.com")).toBeTruthy();
    expect(screen.getByText("https://alpha.example.com")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Register a site/i }),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Manage$/i }));
    // Drill-in: client id, credential actions, snippet, domain policy, events.
    expect((await screen.findAllByText("cli_alpha")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Rotate$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Revoke$/i })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /← Resources/i }));
    expect(
      await screen.findByRole("button", { name: /^Manage$/i }),
    ).toBeTruthy();
  });

  it("covers site rows with the resource search", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await screen.findByText("alpha.example.com");
    await userEvent.type(screen.getByLabelText(/Search resources/i), "zzz");
    expect(screen.queryByText("alpha.example.com")).toBeNull();
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
  });

  it("fails soft when the site list cannot load", async () => {
    identityFetch.mockRejectedValue(new Error("socket closed"));
    renderAccess();
    await openTab("Resources");
    expect(
      await screen.findByText(/Can't reach the Identity API/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Retry$/i })).toBeTruthy();
  });

  it("registers a site and opens its drill-in", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            ...clientAlpha,
            id: "cli_beta",
            displayName: "beta.example.com",
            redirectUris: ["https://beta.example.com/callback"],
            sectorIdentifier: "https://beta.example.com",
          }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Register a site/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );

    expect(await screen.findByText(/is registered as cli_beta/)).toBeTruthy();
    // The drill-in opens for the new client, id and snippet in place.
    expect((await screen.findAllByText("cli_beta")).length).toBeGreaterThan(0);

    const post = identityFetch.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    if (!post) throw new Error("expected a POST to /v1/oauth/clients");
    const body = JSON.parse(String(post[1]?.body));
    expect(body.redirectUris).toEqual(["https://beta.example.com/callback"]);
    expect(body.allowedScopes).toEqual(["openid", "profile"]);
    expect(body.admissionMode).toBe("pre_registered");
  });

  it("validates the origin before registering", async () => {
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Register a site/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      (await screen.findAllByText(/Include the scheme/)).length,
    ).toBeGreaterThan(0);
    expect(
      identityFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("rejects http origins off the loopback", async () => {
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Register a site/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "http://app.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      (await screen.findAllByText(/only allowed for localhost/)).length,
    ).toBeGreaterThan(0);
  });

  it("blocks registration when the Identity plane says assurance is too low", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({ error: "assurance_too_low" }, false, 403),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Register a site/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/provisional session cannot register/),
    ).toBeTruthy();
  });

  it("shows field-level errors returned by the API", async () => {
    identityFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/v1/oauth/clients" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              error: "invalid_client_metadata",
              details: {
                fieldErrors: { redirectUris: ["not an https URI"] },
                formErrors: ["review the form"],
              },
            },
            false,
            400,
          ),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /Register a site/i }),
    );
    await userEvent.type(
      screen.getByLabelText(/^Site origin$/i),
      "https://beta.example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register client/i }),
    );
    expect(
      await screen.findByText(/redirectUris: not an https URI/),
    ).toBeTruthy();
    expect(screen.getByText(/review the form/)).toBeTruthy();
  });

  it("rotates a client after confirmation", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Rotate$/i }),
    );
    expect(screen.getByText(/Rotating issues a new client id/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await userEvent.click(screen.getByRole("button", { name: /^Rotate$/i }));
    identityFetch.mockImplementation((path: string) => {
      if (path.endsWith("/rotate")) {
        return Promise.resolve(
          jsonResponse({ ...clientAlpha, id: "cli_alpha_2" }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(
          jsonResponse({ clients: [{ ...clientAlpha, id: "cli_alpha_2" }] }),
        );
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Rotate and revoke old id/i }),
    );
    expect(
      await screen.findByText(/now uses client id cli_alpha_2/),
    ).toBeTruthy();
    expect((await screen.findAllByText("cli_alpha_2")).length).toBeGreaterThan(
      0,
    );
  });

  it("revokes a client after confirmation and returns to the list", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Revoke$/i }),
    );
    expect(screen.getByText(/Revoking ends sign-in/)).toBeTruthy();
    identityFetch.mockImplementation((path: string) => {
      if (path.endsWith("/revoke")) {
        return Promise.resolve(
          jsonResponse({ ...clientAlpha, state: "revoked" }),
        );
      }
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Revoke this client/i }),
    );
    expect(await screen.findByText(/is revoked/)).toBeTruthy();
    expect(await screen.findByText("No sites registered.")).toBeTruthy();
  });

  it("shows the integration snippet variants in the drill-in", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    const panel = await screen.findByRole("tabpanel", { name: "Sign-in" });
    expect(panel.textContent).toContain("cli_alpha");
    expect(panel.textContent).toContain("https://alpha.example.com/callback");

    await userEvent.click(screen.getByRole("tab", { name: /Callback page/i }));
    expect(
      screen.getByRole("tabpanel", { name: /Callback page/i }).textContent,
    ).toContain("handleRedirectCallback");

    await userEvent.click(screen.getByRole("tab", { name: /Declarative/i }));
    expect(
      screen.getByRole("tabpanel", { name: /Declarative/i }).textContent,
    ).toContain("data-opensesame-signin");

    await userEvent.click(screen.getByRole("tab", { name: /Explicit JS/i }));
    expect(
      screen.getByRole("tabpanel", { name: /Explicit JS/i }).textContent,
    ).toContain("signInAndAccept");
  });

  it("restricts and blocks domains from the drill-in", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    const domain = await screen.findByPlaceholderText(
      /example\.com, localhost:5173/,
    );
    await userEvent.type(domain, "app.example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /Restrict to…/i }),
    );
    expect(await screen.findByText("Restricted")).toBeTruthy();
    expect(screen.getByText("app.example.com")).toBeTruthy();

    await userEvent.type(domain, "evil.example.com");
    await userEvent.click(screen.getByRole("button", { name: /^Block$/i }));
    expect(await screen.findByText(/Blocked evil\.example\.com/)).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
  });

  it("remembers and revokes broker consent for the site's origin", async () => {
    mockClients([clientAlpha]);
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Remember consent/i }),
    );
    expect(
      await screen.findByText(
        /Remembered consent for https:\/\/alpha\.example\.com/,
      ),
    ).toBeTruthy();
    // Two Revoke buttons exist in the drill-in; take the consent row's.
    const consentRow = screen
      .getByRole("heading", { name: "https://alpha.example.com" })
      .closest("li");
    if (!consentRow) throw new Error("consent row not found");
    await userEvent.click(
      within(consentRow).getByRole("button", { name: /^Revoke$/i }),
    );
    expect(await screen.findByText(/Revoked broker consent/)).toBeTruthy();
    expect(screen.getByText(/No site origins approved yet/)).toBeTruthy();
  });

  it("renders only the site's own sign-in events", async () => {
    identityFetch.mockImplementation((path: string) => {
      if (path === "/v1/oauth/clients") {
        return Promise.resolve(jsonResponse({ clients: [clientAlpha] }));
      }
      if (path.startsWith("/v1/audit/events")) {
        return Promise.resolve(
          jsonResponse({
            events: [
              {
                id: "evt_1",
                occurredAt: "2026-08-10T10:00:00Z",
                eventType: "oauth_client.registered",
                outcome: "succeeded",
                clientId: "cli_alpha",
              },
              {
                id: "evt_2",
                occurredAt: "2026-08-10T11:00:00Z",
                eventType: "oauth_client.rotated",
                outcome: "failed",
                clientId: "cli_other",
              },
              {
                id: "evt_3",
                occurredAt: "2026-08-10T12:00:00Z",
                eventType: "session.created",
                outcome: "succeeded",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, false, 404));
    });
    renderAccess();
    await openTab("Resources");
    await userEvent.click(
      await screen.findByRole("button", { name: /^Manage$/i }),
    );
    expect(await screen.findByText("oauth_client.registered")).toBeTruthy();
    expect(screen.queryByText("oauth_client.rotated")).toBeNull();
    expect(screen.queryByText("session.created")).toBeNull();
  });
});
