/** @vitest-environment jsdom */
import * as directory from "@opensesame/app-core/lib/directory.js";
import * as management from "@opensesame/app-core/lib/identity-management.js";
import * as organizations from "@opensesame/app-core/lib/orgs.js";
import type { AgentResponse } from "@opensesame/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPanel } from "./AgentsPanel.js";
import { ServiceAccountsPanel } from "./HostedApplicationsPanel.js";
import { PeoplePanel } from "./HostedPeoplePanels.js";
import { UsersPanel } from "./UsersPanel.js";

const session = {
  principalId: "principal",
  accessToken: "test-token",
  issuerOrigin: "https://identity.example.test",
};
const agent = {
  id: "agent-one",
  displayName: "Build bot",
  state: "claimed" as const,
  createdAt: "2026-10-08T00:00:00Z",
};
const client: directory.OAuthClient = {
  id: "client-one",
  displayName: "Build app",
  admissionMode: "open",
  state: "active",
  redirectUris: ["https://app.example.test/callback"],
  sectorIdentifier: "https://app.example.test",
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
  grantTypes: ["authorization_code"],
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
};
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.search}
      {location.hash}
    </output>
  );
}
function open(ui: ReactNode, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {ui}
      <Location />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No network allowed"),
  );
  vi.spyOn(organizations, "activeOrgProfileId").mockReturnValue("org-one");
  vi.spyOn(organizations, "listOrgMemberships").mockResolvedValue([
    {
      id: "org-one",
      slug: "example",
      displayName: "Example",
      role: "owner",
      state: "active",
    },
  ]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("creates and edits a hosted agent in the selected buffer and confirms revocation", async () => {
  let agents: AgentResponse[] = [agent];
  vi.spyOn(management, "listManagedAgents").mockImplementation(
    async () => agents,
  );
  vi.spyOn(management, "registerManagedAgent").mockImplementation(
    async (displayName) => {
      agents = [...agents, { ...agent, id: "agent-two", displayName }];
      return { id: "agent-two" };
    },
  );
  const update = vi
    .spyOn(management, "updateManagedAgent")
    .mockImplementation(async (id, patch) => {
      const next: AgentResponse = {
        ...agent,
        id,
        displayName: patch.displayName ?? "Release bot",
        state: patch.state ?? "claimed",
      };
      agents = agents.map((row) => (row.id === id ? next : row));
      return next;
    });
  const { container } = open(<AgentsPanel online />, "/identity?view=agents");
  await screen.findByRole("treeitem", { name: /Build bot/ });
  expect(container.querySelector(".panel")).toBeNull();
  expect(screen.queryByLabelText("Agent name")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New agent" }));
  await userEvent.type(
    await screen.findByLabelText("Agent name"),
    "Release bot",
  );
  await userEvent.type(
    screen.getByLabelText("Agent public-key thumbprint"),
    "a".repeat(43),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save agent" }));
  await screen.findByRole("heading", { name: "Release bot" });
  expect(screen.getByTestId("location").textContent).toContain("#agent-two");
  await userEvent.click(
    screen.getByRole("button", { name: "Edit Release bot" }),
  );
  const field = await screen.findByLabelText("Agent name");
  await userEvent.clear(field);
  await userEvent.type(field, "Deployment bot");
  await userEvent.click(screen.getByRole("button", { name: "Save agent" }));
  await screen.findByRole("heading", { name: "Deployment bot" });
  await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(update).not.toHaveBeenCalledWith("agent-two", { state: "revoked" });
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm revocation" }),
  );
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith("agent-two", { state: "revoked" }),
  );
});

it("keeps application registration behind New and selects the API-created client", async () => {
  let clients: directory.OAuthClient[] = [];
  vi.spyOn(directory, "listOAuthClients").mockImplementation(
    async () => clients,
  );
  const create = vi
    .spyOn(directory, "createOAuthClient")
    .mockImplementation(async () => {
      clients = [client];
      return client;
    });
  const { container } = open(
    <ServiceAccountsPanel session={session} online />,
    "/identity?view=service-accounts",
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading applications…")).toBeNull(),
  );
  expect(screen.queryByLabelText("Display name")).toBeNull();
  expect(container.querySelector(".panel")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "New application" }),
  );
  await userEvent.type(screen.getByLabelText("Display name"), "Build app");
  await userEvent.type(
    screen.getByLabelText("Redirect URIs — one per line"),
    client.redirectUris[0],
  );
  await userEvent.type(
    screen.getByLabelText("Sector identifier"),
    client.sectorIdentifier,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Register client" }),
  );
  await screen.findByRole("heading", { name: "Build app" });
  expect(create).toHaveBeenCalledWith({
    displayName: "Build app",
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
  });
  expect(screen.getByTestId("location").textContent).toContain("#client-one");
});

it("loads a directory user from a deep link and preserves organization on edit and cancel", async () => {
  const user = {
    id: "user-one",
    userName: "ada",
    displayName: "Ada",
    active: true,
  };
  const load = vi
    .spyOn(management, "listDirectoryUsers")
    .mockResolvedValue([user]);
  open(
    <UsersPanel online />,
    "/identity?view=people&directory=1&org=org-one#user-one",
  );
  await screen.findByRole("heading", { name: "Ada" });
  expect(load).toHaveBeenCalledWith("org-one");
  expect(
    screen.getByLabelText("Organization").closest(".vault__list"),
  ).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Edit ada" }));
  await screen.findByLabelText("Username / sign-in subject");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByTestId("location").textContent).toBe(
    "?view=people&directory=1&org=org-one#user-one",
  );
  expect(screen.queryByLabelText("Username / sign-in subject")).toBeNull();
});

it("does not ask hosted People or Applications for records without a session", () => {
  const me = vi.spyOn(directory, "getMe");
  const clients = vi.spyOn(directory, "listOAuthClients");
  open(
    <>
      <PeoplePanel online session={null} />
      <ServiceAccountsPanel online session={null} />
    </>,
    "/identity?view=people",
  );
  expect(me).not.toHaveBeenCalled();
  expect(clients).not.toHaveBeenCalled();
});

it("unlinks the selected identity after confirmation and returns to the People list", async () => {
  const identity = {
    id: "linked-one",
    kind: "oidc",
    issuer: "https://login.example.test",
    displayHint: "Work sign-in",
    assurance: "verified",
  };
  let linked = [identity];
  vi.spyOn(directory, "getMe").mockResolvedValue({
    id: "principal",
    state: "verified",
    assurance: "verified",
    createdAt: agent.createdAt,
    version: 1,
  });
  vi.spyOn(directory, "listLinkedIdentities").mockImplementation(
    async () => linked,
  );
  vi.spyOn(directory, "listOrgMembers").mockResolvedValue([]);
  const unlink = vi
    .spyOn(directory, "unlinkIdentity")
    .mockImplementation(async () => {
      linked = [];
    });
  open(
    <PeoplePanel online session={session} />,
    "/identity?view=people#linked%3Alinked-one",
  );
  await screen.findByRole("heading", { name: "Work sign-in" });
  await userEvent.click(
    screen.getByRole("button", { name: "Unlink identity" }),
  );
  expect(unlink).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm removal" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("location").textContent).toBe("?view=people"),
  );
  expect(unlink).toHaveBeenCalledWith("linked-one");
  expect(screen.queryByRole("heading", { name: "Work sign-in" })).toBeNull();
});
