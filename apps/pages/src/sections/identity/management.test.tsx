import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { type JsonObject, isJsonObject } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOrgDirectory } from "../../lib/orgs-directory.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { ServiceAccountsPanel } from "./HostedApplicationsPanel.js";
import { UsersPanel } from "./UsersPanel.js";
import { makeClient } from "./test-fixtures.js";

const session = {
  principalId: "prn_test",
  accessToken: "test",
  issuerOrigin: "https://identity.example",
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
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[path]}>
        {children}
        <Location />
      </MemoryRouter>
    ),
  });
}
let clients = [makeClient()];
let users: JsonObject[] = [];
let agents: JsonObject[] = [];
let refuseRegistration = false;
let writes: { path: string; body: JsonObject }[] = [];
// The organization directory belongs to `identity.federation` (ADR 0130); a
// deployment that shows Users took it, so these cases install it as its
// runtime does, and put back the refusal after.
let uninstallOrgDirectory: (() => void) | null = null;
function input(init?: RequestInit): JsonObject {
  const body = JSON.parse(String(init?.body));
  if (!isJsonObject(body)) throw new Error("Expected object");
  return body;
}
function applicationResponse(
  path: string,
  init?: RequestInit,
): Response | null {
  if (path === "/v1/oauth/clients" && (!init?.method || init.method === "GET"))
    return Response.json({ clients });
  if (
    !path.startsWith("/v1/oauth/clients/") ||
    !init?.method ||
    init.method === "GET"
  )
    return null;
  const body = input(init);
  writes.push({ path, body });
  const updated = { ...makeClient(), ...body };
  clients = [updated];
  return Response.json(updated);
}
beforeEach(() => {
  uninstallOrgDirectory = installOrgDirectory();
  vi.spyOn(identitySeams, "identityBase").mockReturnValue(
    "https://identity.example",
  );
  clients = [makeClient()];
  users = [];
  agents = [];
  writes = [];
  refuseRegistration = false;
  vi.spyOn(identitySeams, "identityFetch").mockImplementation(
    async (path, init) => {
      if (path === "/v1/organizations")
        return Response.json({
          organizations: [
            {
              id: "org:owned",
              displayName: "Owned org",
              role: "owner",
              slug: "owned",
              state: "active",
            },
            {
              id: "org:other",
              displayName: "Member org",
              role: "member",
              slug: "other",
              state: "active",
            },
          ],
        });
      const application = applicationResponse(path, init);
      if (application) return application;
      if (!init?.method || init.method === "GET")
        return path === "/v1/agents"
          ? Response.json({ agents })
          : Response.json({ Resources: users });
      const body = input(init);
      writes.push({ path, body });
      if (path === "/v1/agents" && init.method === "POST") {
        if (refuseRegistration)
          return Response.json({ error: "quota" }, { status: 403 });
        agents.push({
          id: "agt_1",
          displayName: body.displayName,
          state: "provisional",
          createdAt: "2026-09-09T00:00:00Z",
        });
        return Response.json({
          agentId: "agt_1",
          instanceId: "agi_1",
          projectId: "prj_1",
          state: "provisional",
          claimId: "claim_1",
          claimToken: "osc_clm_private-fixture",
          userCode: "ABCD-EFGH",
          verificationUri: "https://identity.example/claim",
          expiresAt: "2026-09-09T01:00:00Z",
        });
      }
      if (path.startsWith("/v1/agents/")) {
        agents = agents.map((agent) => ({ ...agent, ...body }));
        return Response.json(agents[0]);
      }
      if (init.method === "POST") {
        const entry = { id: "user-1", ...body };
        users.push(entry);
        return Response.json(entry);
      }
      const operation = Array.isArray(body.Operations)
        ? body.Operations[0]
        : null;
      if (!isJsonObject(operation) || !isJsonObject(operation.value))
        throw new Error("Expected SCIM patch");
      const patch = operation.value;
      users = users.map((entry) => ({ ...entry, ...patch }));
      return Response.json(users[0]);
    },
  );
});
afterEach(() => {
  clearNotices();
  cleanup();
  uninstallOrgDirectory?.();
  uninstallOrgDirectory = null;
  vi.restoreAllMocks();
});

it("creates and updates users only within the selected owned organization", async () => {
  const user = userEvent.setup();
  open(<UsersPanel online />, "/identity?view=people&directory=1");
  await screen.findByRole("option", { name: "Owned org" });
  expect(screen.queryByRole("option", { name: "Member org" })).toBeNull();
  await user.selectOptions(screen.getByLabelText("Organization"), "org:owned");
  await waitFor(() =>
    expect(screen.queryByText("Loading directory…")).toBeNull(),
  );
  expect(screen.queryByRole("treeitem")).toBeNull();
  await user.click(screen.getByRole("button", { name: "New user" }));
  await user.type(screen.getByLabelText("Username / sign-in subject"), "alice");
  await user.type(screen.getByLabelText("Display name (optional)"), "Alice");
  await user.click(screen.getByRole("button", { name: "Save user" }));
  await screen.findByRole("button", { name: "Edit alice" });
  expect(screen.getByTestId("location").textContent).toContain(
    "org=org%3Aowned#user-1",
  );
  expect(users).toEqual([
    { id: "user-1", userName: "alice", displayName: "Alice", active: true },
  ]);
  expect(writes[0]?.path).toBe("/v1/organizations/org%3Aowned/scim/v2/Users");
  await user.click(screen.getByRole("button", { name: "Edit alice" }));
  await user.click(
    screen.getByRole("checkbox", { name: "Allow organization sign-in" }),
  );
  await user.click(screen.getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(users[0]?.active).toBe(false));
});

it("registers, edits and confirms revocation without showing the claim bearer", async () => {
  const user = userEvent.setup();
  open(<AgentsPanel online />, "/identity?view=agents");
  await waitFor(() => expect(screen.queryByText("Loading agents…")).toBeNull());
  expect(screen.queryByRole("treeitem")).toBeNull();
  const create = screen.getByRole("button", { name: "New agent" });
  expect(create.textContent).toBe("");
  expect(create.querySelector("svg")).not.toBeNull();
  expect(create.className).toContain("icon-btn--sm");
  expect(
    screen.getByRole("group", { name: "Agents commands" }).contains(create),
  ).toBe(true);
  await user.click(create);
  await user.type(screen.getByLabelText("Agent name"), "Deploy");
  await user.type(
    screen.getByLabelText("Agent public-key thumbprint"),
    "a".repeat(43),
  );
  await user.click(screen.getByRole("button", { name: "Save agent" }));
  await screen.findByRole("button", { name: "Edit Deploy" });
  expect(writes[0]?.body).toEqual({
    displayName: "Deploy",
    publicKeyJkt: "a".repeat(43),
  });
  expect(document.body.textContent).not.toContain("osc_clm_private-fixture");
  expect(screen.getByTestId("location").textContent).toBe("?view=agents#agt_1");
  await user.click(screen.getByRole("button", { name: "Edit Deploy" }));
  await user.type(screen.getByLabelText("Agent name"), " safely");
  await user.click(screen.getByRole("button", { name: "Save agent" }));
  await screen.findByRole("button", { name: "Edit Deploy safely" });
  expect(agents[0]?.displayName).toBe("Deploy safely");
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  expect(writes).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await waitFor(() => expect(agents[0]?.state).toBe("revoked"));
});

it("keeps a refused agent draft and disables offline mutations", async () => {
  const user = userEvent.setup();
  refuseRegistration = true;
  const view = open(<AgentsPanel online />, "/identity?view=agents");
  await waitFor(() => expect(screen.queryByText("Loading agents…")).toBeNull());
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.type(screen.getByLabelText("Agent name"), "Draft");
  await user.type(
    screen.getByLabelText("Agent public-key thumbprint"),
    "a".repeat(43),
  );
  await user.click(screen.getByRole("button", { name: "Save agent" }));
  await waitFor(() =>
    expect(
      listNotices().some(
        (n) => n.kind === "status" && n.id === "identity:agents",
      ),
    ).toBe(true),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByDisplayValue("Draft")).toBeTruthy();
  expect(screen.getByTestId("location").textContent).toBe("?view=agents&new=1");
  view.rerender(<AgentsPanel online={false} />);
  expect(screen.getByRole("button", { name: "Save agent" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("edits application redirects without replacing its subject sector", async () => {
  const user = userEvent.setup();
  open(
    <ServiceAccountsPanel online session={session} />,
    "/identity?view=service-accounts",
  );
  await user.click(
    await screen.findByRole("treeitem", { name: /Release pipeline/ }),
  );
  await user.click(screen.getByRole("button", { name: "Edit application" }));
  await user.clear(screen.getByLabelText("Application name"));
  await user.type(screen.getByLabelText("Application name"), "Updated RP");
  await user.clear(screen.getByLabelText("Redirect URIs (one per line)"));
  await user.type(
    screen.getByLabelText("Redirect URIs (one per line)"),
    "https://rp.example/callback",
  );
  await user.click(screen.getByRole("button", { name: "Save application" }));
  await screen.findByRole("button", { name: "Edit application" });
  expect(writes).toEqual([
    {
      path: "/v1/oauth/clients/cli_1",
      body: {
        displayName: "Updated RP",
        redirectUris: ["https://rp.example/callback"],
        grantTypes: ["authorization_code"],
        tokenEndpointAuthMethod: "none",
      },
    },
  ]);
});

it("saves a hosted application edit through the Identity PATCH adapter", async () => {
  const user = userEvent.setup();
  open(
    <ServiceAccountsPanel online session={session} />,
    "/identity?view=service-accounts#cli_1",
  );
  await user.click(
    await screen.findByRole("button", { name: "Edit application" }),
  );
  expect(screen.queryByRole("button", { name: "Visual" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save application" }));
  await screen.findByRole("button", { name: "Edit application" });
  expect(writes[0]?.path).toBe("/v1/oauth/clients/cli_1");
});
