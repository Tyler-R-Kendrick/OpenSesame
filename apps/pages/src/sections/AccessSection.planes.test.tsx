import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the Access screen shows when a plane it draws on is not configured.
 *
 * Its own suite because the answer is different per panel and per plane, and
 * because the first cut of ADR 0090 got it wrong in a way a single "no Host"
 * assertion could not see: grants, requests and policies are the Host's, while
 * Resources is Identity-plane and local-only, and the receipts trail under
 * Sessions is Identity-plane too.
 */

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

import { vaultHooksSeams } from "../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], status: "unlocked" as const }),
});

const access = vi.hoisted(() => ({ listTasks: vi.fn() }));
import { accessSeams } from "../lib/access.js";
Object.assign(accessSeams, access);

const connections = vi.hoisted(() => ({ listConnections: vi.fn() }));
import { connectionSeams } from "../lib/connections.js";
Object.assign(connectionSeams, connections);

import { AccessSection } from "./AccessSection.js";

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

beforeEach(() => {
  online.value = true;
  session.current = { principalId: "prn_op" };
  identityJson.mockResolvedValue({ events: [] });
  identityFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ clients: [] }),
  });
  access.listTasks.mockResolvedValue([]);
  connections.listConnections.mockResolvedValue([]);
});

describe("Access with a plane that is not there (ADR 0090 §7)", () => {
  const originalHostBase = identitySeams.hostBase;
  beforeEach(() => {
    identitySeams.hostBase = () => "";
    connections.listConnections.mockClear();
  });
  afterEach(() => {
    identitySeams.hostBase = originalHostBase;
    cleanup();
  });

  it("says so on a Host-brokered tab, quietly, instead of failing in red", async () => {
    render(
      <MemoryRouter>
        <AccessSection />
      </MemoryRouter>,
    );
    expect(await screen.findByText("No Host connected")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No Identity API is configured/)).toBeNull();
    // The road to a Host is named, not demanded.
    expect(
      screen.getByRole("link", { name: "Settings → Connectivity" }),
    ).toBeTruthy();
    // Nothing was asked of a Host that is not there.
    expect(connections.listConnections).not.toHaveBeenCalled();
  });

  it("keeps every tab reachable, and never hides one a Host does not serve", async () => {
    // The first cut of ADR 0090 gated the whole section on a Host, which hid
    // Resources — where the Sites live. Those are Identity-plane clients plus
    // snippets, domain rules and consents that are local to this browser and
    // need no network at all. Hiding a snippet whose own header reads "no
    // backend" behind a backend check is the bug this ADR exists to remove.
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

    await openTab("Resources");
    // The panel itself renders; the Host note never replaces it.
    expect(
      await screen.findByRole("heading", { name: "Resources" }),
    ).toBeTruthy();
    expect(screen.queryByText("No Host connected")).toBeNull();
    // Its Host half is simply absent — never asked, never "asking", never a
    // failure to report.
    expect(connections.listConnections).not.toHaveBeenCalled();
    expect(screen.queryByText("Asking the Host…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("omits the Sites group when there is no Identity API either", async () => {
    // Asked with no Identity API, the Sites list answered "that client no
    // longer exists on the Identity plane — it may already have been revoked":
    // a 404 dressed as a revocation, about a plane that was never there. A
    // group whose plane is absent is absent, the way an empty group is.
    const withIdentity = identitySeams.identityBase;
    identitySeams.identityBase = () => "";
    identityFetch.mockClear();
    try {
      renderAccess();
      await openTab("Resources");
      expect(
        await screen.findByRole("heading", { name: "Resources" }),
      ).toBeTruthy();
      expect(screen.queryByText("Sites")).toBeNull();
      expect(screen.queryByText("Asking Identity…")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(identityFetch).not.toHaveBeenCalled();
    } finally {
      identitySeams.identityBase = withIdentity;
    }
  });

  it("keeps the Identity-plane receipts trail on the Sessions tab", async () => {
    // Receipts are `/v1/audit/events` on the Identity API, and they sat inside
    // a tab the first cut gated on a Host they never used.
    renderAccess();
    await openTab("Sessions");
    expect(await screen.findByText("No Host connected")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Receipts" }),
    ).toBeTruthy();
    expect(access.listTasks).not.toHaveBeenCalled();
  });
});
