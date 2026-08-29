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
import type { Connection } from "../lib/connections.js";
import type { SecretItem } from "../lib/vault/model.js";

const online = vi.hoisted(() => ({ value: true }));
const session: { current: { principalId: string } | null } = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const connect = vi.hoisted(() => vi.fn());
const connectState: { connecting: boolean; error: Error | null } = vi.hoisted(
  () => ({
    connecting: false,
    error: null,
  }),
);
const currentSession = vi.hoisted(() => vi.fn());
const ensureHostSession = vi.hoisted(() => vi.fn());
const identityJson = vi.hoisted(() => vi.fn());

import { identitySeams } from "../lib/identity.js";
Object.assign(identitySeams, {
  currentSession,
  ensureHostSession,
  hostBase: () => "http://127.0.0.1:8787",
  identityBase: () => "http://127.0.0.1:8788",
  identityJson,
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
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

import { pagesCannotHostNoteSeams } from "../components/PagesCannotHostNote.js";
Object.assign(pagesCannotHostNoteSeams, { PagesCannotHostNote: () => null });

const access = vi.hoisted(() => ({
  listRelayRequests: vi.fn(),
  approveRelayRequest: vi.fn(),
  denyRelayRequest: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  terminateTask: vi.fn(),
  listDelegationOffers: vi.fn(),
  claimDelegation: vi.fn(),
}));

import { AccessError, accessSeams } from "../lib/access.js";
Object.assign(accessSeams, access);

const connections = vi.hoisted(() => ({
  listConnections: vi.fn(),
  authorizeConnection: vi.fn(),
  revokeConnection: vi.fn(),
  awaitConsent: vi.fn(),
  openConsentPopup: vi.fn(),
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

function makeOffer() {
  return {
    id: "dlgo_1",
    state: "pending",
    manifestDigest: "sha256:manifest",
    expiresAt: "2026-08-30T00:00:00Z",
    items: [
      {
        id: "dlgi_1",
        connectionId: "conn_1",
        providerId: "github",
        displayName: "GitHub PAT",
        actions: ["repository.read"],
        resources: ["*"],
        expiresInSeconds: 3600,
        executionMode: "relay",
        required: true,
        dependencies: [],
      },
    ],
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
  // Prefix match: the Requests tab carries a count badge when the inbox is
  // non-empty, so its accessible name is "Requests 2", not "Requests".
  await userEvent.click(
    screen.getByRole("tab", { name: new RegExp(`^${name}`) }),
  );
}

describe("AccessSection", () => {
  beforeEach(() => {
    vault.current = { items: [], status: "unlocked" };
    session.current = { principalId: "prn_op" };
    online.value = true;
    connectState.error = null;
    identityJson.mockResolvedValue({ events: [] });
    currentSession.mockReturnValue({
      accessToken: "tok_1",
      principalId: "prn_op",
    });
    ensureHostSession.mockResolvedValue({ accessToken: "host_tok" });

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
    access.listDelegationOffers.mockResolvedValue([]);
    access.claimDelegation.mockResolvedValue([
      {
        id: "dlg_1",
        offerId: "dlgo_1",
        connectionId: "conn_1",
        claimantSubject: "prn_op",
        grantId: "grt_1",
        executionMode: "relay",
        actions: ["repository.read"],
        resources: ["*"],
        expiresAt: "2026-08-30T01:00:00Z",
        revokedAt: null,
      },
    ]);

    connections.listConnections.mockResolvedValue([]);
    connections.authorizeConnection.mockResolvedValue({
      authorizationUrl: "https://provider.example.com/auth",
      expiresAt: "2026-08-29T16:00:00Z",
    });
    connections.revokeConnection.mockResolvedValue({
      revoked: true,
      providerRevocation: "ok",
    });
    connections.awaitConsent.mockResolvedValue({
      result: "active",
      connection: makeConnection(),
    });
    connections.openConsentPopup.mockReturnValue({
      location: { href: "" },
      closed: false,
      close: vi.fn(),
    });
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

  it("shows only the Resources tab by default", async () => {
    renderAccess();
    for (const name of ["Resources", "Sessions", "Requests", "Policies"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(
      screen
        .getByRole("tab", { name: "Resources" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await screen.findByText("What can be reached")).toBeTruthy();
    expect(screen.queryByText("Task runs")).toBeNull();
    expect(screen.queryByText("The approval inbox")).toBeNull();
    expect(screen.queryByText("Who may do what")).toBeNull();
  });

  it("switches tabs exclusively", async () => {
    renderAccess();
    await screen.findByText("What can be reached");

    await openTab("Sessions");
    expect(await screen.findByText("Task runs")).toBeTruthy();
    expect(screen.queryByText("What can be reached")).toBeNull();

    await openTab("Requests");
    expect(await screen.findByText("The approval inbox")).toBeTruthy();
    expect(screen.queryByText("Task runs")).toBeNull();

    await openTab("Policies");
    expect(await screen.findByText("Who may do what")).toBeTruthy();
    expect(screen.queryByText("The approval inbox")).toBeNull();
  });

  it("badges the Requests tab with the inbox count", async () => {
    access.listRelayRequests.mockResolvedValue([
      makeRelayRequest(),
      { ...makeRelayRequest(), id: "rreq_2" },
    ]);
    renderAccess();
    const tab = screen.getByRole("tab", { name: /Requests/ });
    await waitFor(() => expect(within(tab).getByText("2")).toBeTruthy());
  });

  it("renders no badge when the inbox is empty", async () => {
    renderAccess();
    const tab = screen.getByRole("tab", { name: /Requests/ });
    await waitFor(() => expect(access.listRelayRequests).toHaveBeenCalled());
    expect(tab.textContent).toBe("Requests");
  });

  it("merges connections and vault ceilings into one searchable inventory", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    vault.current = {
      status: "unlocked",
      items: [
        makeSecret({
          name: "Deploy hook",
          connectionRef: "conn/github/pat",
          grantees: ["agt_bot"],
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
    expect(await screen.findByText("GitHub PAT")).toBeTruthy();
    // The reference shows on the connection row and on the secret that backs it.
    expect(screen.getAllByText("conn/github/pat")).toHaveLength(2);
    expect(screen.getByText("Deploy hook")).toBeTruthy();
    expect(screen.getByText("agt_bot")).toBeTruthy();
    expect(screen.getByText("http.post")).toBeTruthy();

    await userEvent.type(screen.getByLabelText(/Search resources/i), "deploy");
    expect(screen.queryByText("GitHub PAT")).toBeNull();
    expect(screen.getByText("Deploy hook")).toBeTruthy();

    await userEvent.clear(screen.getByLabelText(/Search resources/i));
    // Status text is searchable too, and matches only the connection row.
    await userEvent.type(screen.getByLabelText(/Search resources/i), "active");
    expect(screen.getByText("GitHub PAT")).toBeTruthy();
    expect(screen.queryByText("Deploy hook")).toBeNull();
  });

  it("authorizes a connection from its row", async () => {
    connections.listConnections.mockResolvedValue([
      makeConnection({ status: "pending" }),
    ]);
    renderAccess();
    await screen.findByText("GitHub PAT");
    await userEvent.click(screen.getByRole("button", { name: /^Authorize$/i }));
    await waitFor(() =>
      expect(connections.authorizeConnection).toHaveBeenCalledWith("conn_1"),
    );
    expect(ensureHostSession).toHaveBeenCalled();
    expect(await screen.findByText(/GitHub PAT is authorized/)).toBeTruthy();
  });

  it("revokes a connection after confirmation", async () => {
    connections.listConnections.mockResolvedValue([makeConnection()]);
    renderAccess();
    await screen.findByText("GitHub PAT");
    await userEvent.click(screen.getByRole("button", { name: /^Revoke$/i }));
    await userEvent.click(screen.getByRole("button", { name: /Revoke it/i }));
    await waitFor(() =>
      expect(connections.revokeConnection).toHaveBeenCalledWith("conn_1"),
    );
    expect(await screen.findByText(/GitHub PAT was revoked/)).toBeTruthy();
  });

  it("shows locked and missing vault notes in Resources", async () => {
    vault.current = { items: [], status: "locked" };
    const { unmount } = renderAccess();
    expect(await screen.findByText(/Vault is locked/)).toBeTruthy();
    unmount();

    vault.current = { items: [], status: "empty" };
    renderAccess();
    expect(await screen.findByText(/No vault on this device/)).toBeTruthy();
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
    expect(await screen.findByText("No live task runs")).toBeTruthy();
  });

  it("approves and denies relay requests with the digest echoed", async () => {
    access.listRelayRequests.mockResolvedValue([makeRelayRequest()]);
    renderAccess();
    await openTab("Requests");
    expect(await screen.findByText("repository.read")).toBeTruthy();
    expect(screen.getByText("repo:acme/catalog")).toBeTruthy();
    expect(screen.getByText(/sha256:abc123/)).toBeTruthy();
    expect(screen.getByText(/"path": "\/README.md"/)).toBeTruthy();

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

    await userEvent.click(screen.getByRole("button", { name: /^Deny$/i }));
    await waitFor(() =>
      expect(access.denyRelayRequest).toHaveBeenCalledWith(
        "rreq_1",
        "sha256:abc123",
      ),
    );
    expect(
      await screen.findByText(/Denied — reviewed digest sha256:abc123/),
    ).toBeTruthy();
  });

  it("surfaces already-decided wording when the Host answers 404", async () => {
    access.listRelayRequests.mockResolvedValue([makeRelayRequest()]);
    access.approveRelayRequest.mockRejectedValue(
      new AccessError(
        404,
        "not_found",
        "Already decided or lapsed — someone else got there, or the request expired. Reload the inbox.",
      ),
    );
    renderAccess();
    await openTab("Requests");
    await screen.findByText("repository.read");
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/i }));
    expect(
      await screen.findByText(
        /Already decided or lapsed — someone else got there/,
      ),
    ).toBeTruthy();
  });

  it("shows the empty inbox as a good state", async () => {
    renderAccess();
    await openTab("Requests");
    expect(await screen.findByText("Nothing waiting on you")).toBeTruthy();
    expect(screen.getByText("Standing privilege stays at zero.")).toBeTruthy();
  });

  it("claims a delegation offer with token, code, and all item ids", async () => {
    access.listDelegationOffers.mockResolvedValue([makeOffer()]);
    renderAccess();
    await openTab("Requests");
    expect(await screen.findByText(/Offer dlgo_1/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Claim$/i }));
    await userEvent.type(screen.getByLabelText(/Claim token/i), "osc_dlg_x.y");
    await userEvent.type(screen.getByLabelText(/User code/i), "AAAA-BBBB");
    await userEvent.click(screen.getByRole("button", { name: /Claim it/i }));

    await waitFor(() =>
      expect(access.claimDelegation).toHaveBeenCalledWith({
        claimToken: "osc_dlg_x.y",
        userCode: "AAAA-BBBB",
        acceptedItemIds: ["dlgi_1"],
      }),
    );
    expect(
      await screen.findByText(/Claimed — 1 delegation minted/),
    ).toBeTruthy();
  });

  it("saves policy and binds an identity against the picked connection", async () => {
    connections.listConnections.mockResolvedValue([
      makeConnection(),
      makeConnection({
        connectionId: "conn_2",
        displayName: "S3 bucket",
        providerId: "aws",
      }),
    ]);
    renderAccess();
    await openTab("Policies");
    await screen.findByText("Who may do what");

    // The first connection is selected by default; pick the second.
    await userEvent.selectOptions(
      screen.getByLabelText(/^Connection$/i),
      "conn_2",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save rules/i }));
    await waitFor(() =>
      expect(connections.updateConnectionPolicy).toHaveBeenCalledWith(
        "conn_2",
        { shareability: "delegable", maxInvokeLevel: 2 },
      ),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Bind an identity/i }),
    );
    await userEvent.type(screen.getByLabelText(/Identifier/i), "proj_9");
    await userEvent.click(screen.getByRole("button", { name: /^Bind$/i }));
    await waitFor(() =>
      expect(connections.bindConnection).toHaveBeenCalledWith("conn_2", {
        targetKind: "project",
        targetId: "proj_9",
      }),
    );
  });

  it("disables Host actions and shows offline notes while offline", async () => {
    online.value = false;
    renderAccess();
    expect(
      await screen.findByText(/Registration writes to the Identity service/),
    ).toBeTruthy();

    await openTab("Sessions");
    expect(await screen.findByText(/You are offline/)).toBeTruthy();
    expect(access.listTasks).not.toHaveBeenCalled();

    await openTab("Requests");
    expect(await screen.findByText(/Requests live on the Host/)).toBeTruthy();
  });

  it("prompts for a principal in Sessions when there is no session", async () => {
    session.current = null;
    connect.mockResolvedValue(undefined);
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("No principal on this tab")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Connect to Identity/i }),
    );
    expect(connect).toHaveBeenCalled();
  });

  it("shows the agent receipt trail in Sessions", async () => {
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
          eventType: "session.created",
          outcome: "succeeded",
        },
      ],
    });
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("agent.registered")).toBeTruthy();
    expect(screen.queryByText("session.created")).toBeNull();
  });

  it("registers an agent and shows the claim ceremony", async () => {
    identityJson.mockResolvedValue({
      agentId: "agt_1",
      instanceId: "ins_1",
      state: "pending_claim",
      claimId: "clm_1",
      claimToken: "claim-secret-token",
      userCode: "WDJD-MKSK",
      verificationUri: "https://id.example.com/device",
      expiresAt: "2026-08-19T16:00:00Z",
    });
    renderAccess();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    await userEvent.type(
      screen.getByLabelText(/Display name/i),
      "Nightly release bot",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText("WDJD-MKSK")).toBeTruthy();
    expect(screen.getByText("pending_claim")).toBeTruthy();
    // The claim token is copy-only, never rendered.
    expect(screen.queryByText("claim-secret-token")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Copy claim token/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "claim-secret-token",
    );
  });
});
