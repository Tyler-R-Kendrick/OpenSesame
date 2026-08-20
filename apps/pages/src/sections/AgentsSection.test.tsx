import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = vi.hoisted(() => ({ value: true }));
const session = vi.hoisted(() => ({
  current: { principalId: "prn_op" },
}));
const connect = vi.hoisted(() => vi.fn());
const connectState = vi.hoisted(() => ({
  connecting: false,
  error: null,
}));
const currentSession = vi.hoisted(() => vi.fn());
const hostFetch = vi.hoisted(() => vi.fn());
const identityJson = vi.hoisted(() => vi.fn());

import { IdentityError, identitySeams } from "../lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  currentSession,
  hostBase: () => "http://127.0.0.1:8787",
  hostFetch,
  identityBase: () => "http://127.0.0.1:8788",
  identityJson,
  useConnect: () => ({
    connect,
    connecting: connectState.connecting,
    error: connectState.error,
  }),
  useIdentitySession: () => session.current});
import { useOnlineSeams } from "../lib/use-online.js";
const originalUseOnlineSeams = { ...useOnlineSeams };
Object.assign(useOnlineSeams, {useOnline: () => online.value});
const vault = vi.hoisted(() => ({
  current: { items: [], status: "unlocked" },
}));

import { vaultHooksSeams } from "../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {useVault: () => vault.current});


import { planeNoteSeams } from "../components/PlaneNote.js";
const originalPlaneNoteSeams = { ...planeNoteSeams };
Object.assign(planeNoteSeams, { PagesCannotHostNote: () => null });

import type { SecretItem } from "../lib/vault/model.js";
import { AgentsSection } from "./AgentsSection.js";

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

function renderAgents() {
  return render(
    <MemoryRouter>
      <AgentsSection />
    </MemoryRouter>,
  );
}

describe("AgentsSection", () => {
  beforeEach(() => {
    vault.current = { items: [], status: "unlocked" };
    session.current = { principalId: "prn_op" };
    online.value = true;
    connectState.error = null;
    identityJson.mockResolvedValue({ events: [] });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("prompts for a principal when there is no session", async () => {
    session.current = null;
    connect.mockResolvedValue(undefined);
    renderAgents();
    expect(screen.getByText("Not connected to Identity")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Connect to Identity/i }),
    );
    expect(connect).toHaveBeenCalled();
  });

  it("shows the connect error and offline notes", () => {
    session.current = null;
    online.value = false;
    connectState.error = new Error("identity down");
    renderAgents();
    expect(screen.getByRole("alert").textContent).toMatch(/identity down/);
    expect(
      screen.getAllByText(/Offline — connecting needs the Identity service/i)
        .length,
    ).toBeGreaterThan(0);
  });

  it("lists agent secrets with grantees and ceilings when unlocked", () => {
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
        makeSecret({
          id: "itm_s2",
          name: "Bare secret",
        }),
        // Trashed secrets are hidden.
        makeSecret({ id: "itm_s3", name: "Old", deletedAt: "2026-08-01" }),
      ],
    };
    renderAgents();
    expect(screen.getByText("2 secrets")).toBeTruthy();
    expect(screen.getByText("Deploy hook")).toBeTruthy();
    expect(screen.getByText("conn/github/pat")).toBeTruthy();
    expect(screen.getByText("agt_bot")).toBeTruthy();
    expect(screen.getByText("http.post")).toBeTruthy();
    expect(screen.getByText("Bare secret")).toBeTruthy();
    expect(screen.getByText("No connection reference")).toBeTruthy();
    expect(screen.getByText(/no agent can draw on this yet/)).toBeTruthy();
    expect(screen.getByText(/Empty ceiling/)).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
  });

  it("shows empty and locked vault states", () => {
    const { unmount } = renderAgents();
    expect(screen.getByText("No agent secrets yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Add a secret/i }).getAttribute("href"),
    ).toBe("/vault/new/secret");
    unmount();

    vault.current = { items: [], status: "locked" };
    renderAgents();
    expect(screen.getByText("Vault is locked")).toBeTruthy();
  });

  it("shows the no-vault state", () => {
    vault.current = { items: [], status: "empty" };
    renderAgents();
    expect(screen.getByText("No vault on this device")).toBeTruthy();
  });

  it("requires a task id before inspecting", async () => {
    renderAgents();
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(screen.getByRole("alert").textContent).toMatch(
      /Enter the task run id/,
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("maps Host error statuses to plain-language task errors", async () => {
    hostFetch.mockResolvedValue({ ok: false, status: 404 });
    renderAgents();
    await userEvent.type(
      screen.getByLabelText(/Task run id/i),
      "00000000-0000-0000-0000-000000000000",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(
      await screen.findByText(/No task with that id on this Host/),
    ).toBeTruthy();

    hostFetch.mockResolvedValue({ ok: false, status: 503 });
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(
      await screen.findByText(/could not authorize this user session/),
    ).toBeTruthy();

    hostFetch.mockResolvedValue({ ok: false, status: 400 });
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(
      await screen.findByText(/rejected that id as malformed/),
    ).toBeTruthy();

    hostFetch.mockResolvedValue({ ok: false, status: 403 });
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(await screen.findByText(/refused this user session/)).toBeTruthy();

    hostFetch.mockResolvedValue({ ok: false, status: 500 });
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(await screen.findByText(/The Host answered 500/)).toBeTruthy();
  });

  it("reports an unreachable Host for network failures", async () => {
    hostFetch.mockRejectedValue(new TypeError("fetch failed"));
    renderAgents();
    await userEvent.type(screen.getByLabelText(/Task run id/i), "task-1");
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(
      await screen.findByText(
        /Host API unreachable at http:\/\/127.0.0.1:8787/,
      ),
    ).toBeTruthy();
  });

  it("compares the ceiling against held capabilities", async () => {
    hostFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          task_run_id: "task_1",
          state_version: 7,
          status: "active",
          capability_ceiling: {
            capabilities: [
              { action: "http.post", resource: "https://a.example.com" },
              {
                action: "http.get",
                resource: {
                  values: ["https://b.example.com", "https://c.example.com"],
                },
              },
              { action: "dns.resolve", resource: "example.com" },
            ],
          },
          current_capabilities: [
            { action: "http.post", resource: "https://a.example.com" },
            {
              action: "http.get",
              resource: { value: "https://b.example.com" },
            },
            { action: "fs.read", resource: "/etc/passwd" },
          ],
        }),
    });
    renderAgents();
    await userEvent.type(screen.getByLabelText(/Task run id/i), "task_1");
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(await screen.findByText("task_1")).toBeTruthy();
    expect(screen.getByText("Held in full")).toBeTruthy();
    expect(screen.getByText("Narrowed to https://b.example.com")).toBeTruthy();
    expect(screen.getByText(/Released — not held/)).toBeTruthy();
    // A held capability outside the ceiling is flagged.
    expect(
      screen.getByText(/Held but outside the ceiling — report this Host/),
    ).toBeTruthy();
    expect(screen.getByText("fs.read → /etc/passwd")).toBeTruthy();
  });

  it("notes when a task carries no capabilities", async () => {
    hostFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          task_run_id: "task_2",
          state_version: 1,
          status: "pending",
        }),
    });
    renderAgents();
    await userEvent.type(screen.getByLabelText(/Task run id/i), "task_2");
    await userEvent.click(screen.getByRole("button", { name: /^Inspect$/i }));
    expect(
      await screen.findByText(/carries no capabilities at all/),
    ).toBeTruthy();
  });

  it("disables inspection while offline", () => {
    online.value = false;
    renderAgents();
    expect(
      (overlapCast(screen.getByRole("button", { name: /^Inspect$/i })))
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/You are offline/)).toBeTruthy();
  });

  it("generates a keypair and shows the thumbprint", async () => {
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    // RFC 7638 thumbprint renders once the key is made.
    const code = await screen.findByText(/^[A-Za-z0-9_-]{20,}$/);
    expect(code).toBeTruthy();
    expect(screen.getByRole("button", { name: /Regenerate/i })).toBeTruthy();
    // Copy affordance works through the clipboard.
    await userEvent.click(
      screen.getByRole("button", { name: /Copy thumbprint/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  it("requires a display name to register", async () => {
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    const form = overlapCast(screen
      .getByRole("button", { name: /Register agent/i })
      .closest("form"));
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Give the agent a display name/,
    );
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
    renderAgents();
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
    expect(screen.getByText(/Registered as/)).toBeTruthy();
    // The claim token is copy-only, never rendered.
    expect(screen.queryByText("claim-secret-token")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Copy claim token/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "claim-secret-token",
    );
    expect(
      screen.getByRole("link", { name: /Open verification page/i }),
    ).toBeTruthy();
  });

  it("refuses to open a non-browsable verification URI", async () => {
    identityJson.mockResolvedValue({
      agentId: "agt_1",
      instanceId: "ins_1",
      state: "pending_claim",
      claimId: "clm_1",
      claimToken: "tok",
      userCode: "CODE-1234",
      verificationUri: "javascript:alert(1)",
      expiresAt: "2026-08-19T16:00:00Z",
    });
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    await userEvent.type(screen.getByLabelText(/Display name/i), "Bot");
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(
      await screen.findByText(/verification address this app will not open/),
    ).toBeTruthy();
  });

  it("blocks registration when no principal session is active", async () => {
    currentSession.mockReturnValue(null);
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    await userEvent.type(screen.getByLabelText(/Display name/i), "Bot");
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(
      await screen.findByText(
        /does not have one\. Connect on the Authority tab/,
      ),
    ).toBeTruthy();
    // Registration itself never went out — only the audit poll did.
    expect(
      identityJson.mock.calls.filter(([path]) => path === "/v1/agents"),
    ).toHaveLength(0);
  });

  it("discards the claim when the session changes mid-flight", async () => {
    identityJson.mockImplementation(async (path: string) => {
      if (path !== "/v1/agents") return { events: [] };
      currentSession.mockReturnValue({ accessToken: "tok_other" });
      return {
        agentId: "agt_1",
        instanceId: "ins_1",
        state: "pending_claim",
        claimId: "clm_1",
        claimToken: "tok",
        userCode: "CODE-1234",
        verificationUri: "https://id.example.com/device",
        expiresAt: "2026-08-19T16:00:00Z",
      };
    });
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    await userEvent.type(screen.getByLabelText(/Display name/i), "Bot");
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText(/session changed since/)).toBeTruthy();
  });

  it("maps Identity registration errors", async () => {
    renderAgents();
    await userEvent.click(
      screen.getByRole("button", { name: /Generate keypair/i }),
    );
    await screen.findByRole("button", { name: /Regenerate/i });
    await userEvent.type(screen.getByLabelText(/Display name/i), "Bot");

    identityJson.mockRejectedValue(new IdentityError("denied", 403));
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText(/Policy denied/)).toBeTruthy();

    identityJson.mockRejectedValue(new IdentityError("expired", 401));
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(
      await screen.findByText(/principal session was rejected/),
    ).toBeTruthy();

    identityJson.mockRejectedValue(new IdentityError("bad", 400));
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText(/1–128 characters/)).toBeTruthy();

    identityJson.mockRejectedValue(new IdentityError("oops", 500));
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText(/Identity answered 500/)).toBeTruthy();

    identityJson.mockRejectedValue(new TypeError("fetch failed"));
    await userEvent.click(
      screen.getByRole("button", { name: /Register agent/i }),
    );
    expect(await screen.findByText(/Identity API unreachable/)).toBeTruthy();
  });

  it("shows the audit trail filtered to agent events", async () => {
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
        {
          id: "evt_3",
          occurredAt: "2026-08-19T10:02:00Z",
          eventType: "connection.invoked",
          outcome: "denied",
          metadata: { agentInstanceId: "ins_1" },
        },
      ],
    });
    renderAgents();
    expect(await screen.findByText("agent.registered")).toBeTruthy();
    // Non-agent events are filtered out.
    expect(screen.queryByText("session.created")).toBeNull();
    // Events with an agent instance id count as agent events.
    expect(screen.getByText("connection.invoked")).toBeTruthy();
  });

  it("shows the empty trail state", async () => {
    identityJson.mockResolvedValue({ events: [] });
    renderAgents();
    expect(await screen.findByText("No agent events yet")).toBeTruthy();
  });

  it("surfaces audit trail failures", async () => {
    identityJson.mockRejectedValue(new IdentityError("expired", 401));
    renderAgents();
    expect(
      await screen.findByText(/session was rejected, so the trail/),
    ).toBeTruthy();
  });

  it("reloads the trail from the refresh button", async () => {
    renderAgents();
    await screen.findByText("No agent events yet");
    await userEvent.click(
      screen.getByRole("button", { name: /Reload trail/i }),
    );
    await waitFor(() =>
      expect(
        identityJson.mock.calls.filter(
          ([path]) => path === "/v1/audit/events?limit=50",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
