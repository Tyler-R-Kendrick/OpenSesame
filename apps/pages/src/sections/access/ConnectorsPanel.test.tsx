import {
  connectRoadSeams,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  syncConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { listPendingShares } from "@opensesame/app-core/lib/local-share-grants-approvals.js";
import {
  createLocalShare,
  listLocalShares,
} from "@opensesame/app-core/lib/local-share-grants.js";
import type { DirectoryConnection } from "@opensesame/app-core/lib/nango-directory.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "./ConnectorsPanel.js";

const github: DirectoryConnection = {
  id: "1",
  connectionId: "octocat",
  integrationId: "github",
  provider: "github",
  displayName: "GitHub",
  endUser: "octo@example.com",
  createdAt: null,
  errors: 0,
};
const slack: DirectoryConnection = {
  id: "2",
  connectionId: "acme",
  integrationId: "slack",
  provider: "slack",
  displayName: "Slack",
  endUser: null,
  createdAt: null,
  errors: 1,
};

const originalList = connectorDirectorySeams.listDirectory;
const originalConnections = connectionSeams.listConnections;

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github, slack],
  }));
  // Nothing configured on the Connections page: these rows are the directory's.
  connectionSeams.listConnections = vi.fn(async () => []);
});

afterEach(() => {
  resetConnectRoadSeams();
  cleanup();
  vi.unstubAllGlobals();
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  connectionSeams.listConnections = originalConnections;
  kvDelete("connector-directory.v1");
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Two connectors imported from a directory (on the Connections page). */
async function seeded() {
  const fixture = await localRequestFixture();
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: fixture.tomb,
  });
  return fixture;
}

/** The same, with Test person already granted the GitHub one. */
async function granted() {
  const fixture = await seeded();
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "nango:github/octocat",
    resourceLabel: "GitHub · octo@example.com",
    policy: "use",
    durationSeconds: 3600,
  });
  return fixture;
}

function mount(tomb: string) {
  return render(
    <MemoryRouter>
      <ConnectorsPanel tomb={tomb} />
    </MemoryRouter>,
  );
}

function accessRow(name: string) {
  const list = screen.getByRole("list", { name: "Connector access" });
  const heading = within(list).getByRole("heading", { name });
  const item = heading.closest("li");
  if (!item) throw new Error(`${name} is not in a row`);
  return within(item);
}

it("lists access, not connectors: only the connector someone holds a grant on", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  // Slack is known (imported) but nobody holds it: it is not listed.
  expect(screen.queryByRole("heading", { name: "Slack" })).toBeNull();
  const row = accessRow("GitHub · octo@example.com");
  // Health is a StatusMark glyph whose sentence is its accessible name.
  expect(row.getByRole("img", { name: "Authorized" })).toBeTruthy();
  expect(row.getByText("Test person")).toBeTruthy();
  expect(row.getByText("1 bound")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("never asks for a directory, a key or a sync: that is the Connections page's", async () => {
  const fixture = await seeded();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "No connector access" });
  expect(screen.queryByLabelText("Directory endpoint")).toBeNull();
  expect(screen.queryByLabelText("Environment key")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /sync|import|export/i }),
  ).toBeNull();
  expect(screen.queryByText(/api\.nango\.dev/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Add connector access" }),
  ).toBeTruthy();
});

it("Add offers the connectors this device knows; choosing one grants it and lists it", async () => {
  const fixture = await seeded();
  mount(fixture.tomb);
  const add = await screen.findByRole("button", {
    name: "Add connector access",
  });
  await userEvent.click(add);
  const choices = within(
    screen.getByRole("list", { name: "Choose a connector" }),
  );
  expect(choices.getByRole("button", { name: /Slack/ })).toBeTruthy();
  await userEvent.click(
    choices.getByRole("button", { name: /GitHub · octo@example\.com/ }),
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Identity"));
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Invoke");
  await userEvent.selectOptions(screen.getByLabelText("Duration"), "1 day");
  const form = screen.getByRole("group", { name: /^Bind GitHub/ });
  await userEvent.click(within(form).getByRole("button", { name: "Bind" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: "Add connector access" }),
    ).toBeNull(),
  );
  const row = accessRow("GitHub · octo@example.com");
  expect(row.getByText("Invoke")).toBeTruthy();
  const shares = await listLocalShares(fixture.tomb);
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceId).toBe("nango:github/octocat");
  expect(shares[0]?.policy).toBe("invoke");
  // The keyboard follows the grant to its row.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      row.getByRole("button", { name: "Bind" }),
    ),
  );
});

it("offers a new application and binds the connector to it", async () => {
  const fixture = await seeded();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  const choices = within(
    screen.getByRole("list", { name: "Choose a connector" }),
  );
  await userEvent.click(choices.getByRole("button", { name: /^Slack/ }));
  const identity = await screen.findByLabelText("Identity");
  await waitFor(() =>
    expect(
      within(identity).getByRole("option", { name: "Test application" }),
    ).toBeTruthy(),
  );
  await userEvent.selectOptions(identity, "Test application");
  const form = screen.getByRole("group", { name: /^Bind Slack/ });
  await userEvent.click(
    within(form).getByRole("button", { name: "Request approval" }),
  );
  await waitFor(() => {
    expect(screen.getByText("Approval requested.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Slack" })).toBeTruthy();
  });
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
  await waitFor(async () => {
    const pending = await listPendingShares(fixture.tomb);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.principalId).toBe(fixture.applicationId);
    expect(
      screen.getByRole("button", { name: "Approve Test application" }),
    ).toBeTruthy();
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Approve Test application" }),
  );
  await waitFor(() => expect(screen.getByText("Grant approved.")).toBeTruthy());
  await waitFor(async () => {
    const shares = await listLocalShares(fixture.tomb);
    expect(shares).toHaveLength(1);
    expect(shares[0]?.principalId).toBe(fixture.applicationId);
  });
});

it("asks for approval before an agent is bound to a connector", async () => {
  const fixture = await seeded();
  await fixture.change({ action: "create", kind: "agent", name: "Helper" });
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  const choices = within(
    screen.getByRole("list", { name: "Choose a connector" }),
  );
  await userEvent.click(choices.getByRole("button", { name: /^Slack/ }));
  const identity = await screen.findByLabelText("Identity");
  await waitFor(() =>
    expect(
      within(identity).getByRole("option", { name: "Helper" }),
    ).toBeTruthy(),
  );
  await userEvent.selectOptions(identity, "Helper");
  const form = screen.getByRole("group", { name: /^Bind Slack/ });
  await userEvent.click(
    within(form).getByRole("button", { name: "Request approval" }),
  );
  await waitFor(() => {
    expect(screen.getByText("Approval requested.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Slack" })).toBeTruthy();
  });
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Approve Helper" }));
  await waitFor(async () => {
    expect(await listLocalShares(fixture.tomb)).toHaveLength(1);
  });
});

it("with nothing configured and Connections on, Add offers the way to configure a connector", async () => {
  connectRoadSeams.pagesOpen = () => true;
  const fixture = await localRequestFixture();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  expect(
    screen.getByRole("heading", { name: "No connectors configured" }),
  ).toBeTruthy();
  const choices = within(
    screen.getByRole("list", { name: "Choose a connector" }),
  );
  expect(choices.queryAllByRole("button")).toHaveLength(0);
  expect(
    choices.getByRole("link", { name: "New connector" }).getAttribute("href"),
  ).toBe("/connections#catalog");
});

it("with Connections off, Add leads to no page that is not there", async () => {
  const fixture = await localRequestFixture();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  const choices = within(
    screen.getByRole("list", { name: "Choose a connector" }),
  );
  expect(choices.queryAllByRole("link")).toHaveLength(0);
});

it("Escape closes the choices and returns the keyboard to Add", async () => {
  const fixture = await seeded();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  await userEvent.click(screen.getByRole("button", { name: /Slack/ }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: "Add connector access" }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add connector access" }),
    ),
  );
});

it("revoking the last grant takes the connector off the access list", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  await userEvent.click(
    accessRow("GitHub · octo@example.com").getByRole("button", {
      name: "Revoke",
    }),
  );
  await screen.findByRole("heading", { name: "No connector access" });
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
});

it("grants one more from a listed row, and returns the keyboard to its Bind on cancel", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  const row = accessRow("GitHub · octo@example.com");
  await userEvent.click(row.getByRole("button", { name: "Bind" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Identity"));
  // The form carries the verb while it is open; the row's Bind steps aside.
  expect(row.getAllByRole("button", { name: "Bind" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      row.getByRole("button", { name: "Bind" }),
    ),
  );
});

it("configures a granted connector: alias, disable, and bind defaults", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  const row = accessRow("GitHub · octo@example.com");
  await userEvent.click(row.getByRole("button", { name: "Configure" }));
  const form = screen.getByRole("group", {
    name: "Configure GitHub · octo@example.com",
  });
  await userEvent.type(
    within(form).getByLabelText("Display name"),
    "CI mirror",
  );
  await userEvent.click(within(form).getByLabelText(/Enabled/));
  await userEvent.selectOptions(
    within(form).getByLabelText("Bind policy"),
    "Invoke",
  );
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  const renamed = await waitFor(() => accessRow("CI mirror"));
  expect(await renamed.findByRole("img", { name: "Disabled" })).toBeTruthy();
  // A disabled connector refuses new grants, here and in the choices.
  expect(
    renamed.getByRole<HTMLButtonElement>("button", { name: "Bind" }).disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "Add connector access" }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: /CI mirror/ })
      .disabled,
  ).toBe(true);
});
