/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import * as directory from "../lib/local-directory.js";
import * as devices from "../lib/local-devices.js";
import * as idp from "../lib/idp-registry.js";
import { notifyLocalIamChange } from "../lib/local-iam-events.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { IdentityTree } from "./IdentityTree.js";

const originalVault = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVaultStore: () => ({ activeTomb: () => "tomb" }),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(vaultHooksSeams, originalVault);
});

function countOf(name: string): string | null {
  return (
    screen.getByRole("treeitem", { name }).querySelector(".railtree__count")
      ?.textContent ?? null
  );
}

function renderTree() {
  return render(
    <MemoryRouter>
      <IdentityTree open active onToggle={() => undefined} />
    </MemoryRouter>,
  );
}

it("updates every identity subtree when directory or providers change", async () => {
  const read = vi.spyOn(directory, "ensureOwnerPerson").mockResolvedValue({
    version: 2,
    revision: 1,
    entries: [
      { id: "local_owner", kind: "person", name: "Owner", enabled: true },
      {
        id: "local_org",
        kind: "organization",
        name: "Personal",
        enabled: true,
      },
      {
        id: "local_00000000-0000-4000-8000-000000000001",
        kind: "agent",
        name: "Support",
        enabled: true,
      },
    ],
    memberships: [],
  });
  const providers = vi.spyOn(idp, "listIdpRegistrations").mockReturnValue([]);
  const deviceList = vi.spyOn(devices, "ensureThisDevice").mockResolvedValue([]);
  renderTree();
  await waitFor(() => expect(countOf("People")).toBe("1"));
  expect(countOf("Organization")).toBe("1");
  expect(countOf("Agents")).toBe("1");
  expect(countOf("Providers")).toBe("-");
  expect(countOf("Devices")).toBe("-");
  read.mockResolvedValue({
    version: 2,
    revision: 2,
    entries: [
      { id: "local_alice", kind: "person", name: "Alice", enabled: true },
      { id: "local_support", kind: "agent", name: "Support", enabled: true },
      { id: "local_bot", kind: "agent", name: "Deploy", enabled: true },
      {
        id: "local_app",
        kind: "application",
        name: "Wiki",
        enabled: true,
      },
      {
        id: "local_org",
        kind: "organization",
        name: "Acme",
        enabled: true,
      },
    ],
    memberships: [],
  });
  providers.mockReturnValue([
    {
      id: "google",
      issuer: "https://accounts.google.com",
      label: "Google",
      kind: "first-class",
      registeredAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  deviceList.mockResolvedValue([
    {
      id: "dev_1",
      name: "Desk laptop",
      platform: "macOS",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  notifyLocalIamChange();
  await waitFor(() => expect(countOf("People")).toBe("1"));
  expect(countOf("Agents")).toBe("2");
  expect(countOf("Applications")).toBe("1");
  expect(countOf("Organization")).toBe("1");
  expect(countOf("Providers")).toBe("1");
  expect(countOf("Devices")).toBe("1");
});
