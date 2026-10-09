import { resetConnectRoadSeams } from "@opensesame/app-core/lib/connect-roads.js";
import { connectionSeams } from "@opensesame/app-core/lib/connections.js";
import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  syncConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import { kvDelete } from "@opensesame/app-core/lib/kv.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
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
    <MemoryRouter
      initialEntries={[
        "/access?view=connectors#local-connectors/nango%3Agithub%2Foctocat",
      ]}
    >
      <ConnectorsPanel tomb={tomb} />
    </MemoryRouter>,
  );
}

function accessRow(name: string) {
  const list = screen.getByRole("region", { name: "Connector access" });
  const heading = within(list).getByRole("heading", { name });
  const item = heading.closest<HTMLElement>(".detail");
  if (!item) throw new Error(`${name} is not in a row`);
  return within(item);
}

it("a disabled connector stays listed after its last grant, so it can be enabled again", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  await userEvent.click(
    accessRow("GitHub · octo@example.com").getByRole("button", {
      name: "Configure",
    }),
  );
  const form = screen.getByRole("group", {
    name: "Configure GitHub · octo@example.com",
  });
  await userEvent.click(within(form).getByLabelText(/Enabled/));
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  const row = await waitFor(() => accessRow("GitHub · octo@example.com"));
  await row.findByRole("img", { name: "Disabled" });
  await userEvent.click(row.getByRole("button", { name: "Revoke" }));
  await waitFor(async () =>
    expect(await listLocalShares(fixture.tomb)).toHaveLength(0),
  );
  // Nobody holds it, and its row is still where it is switched back on.
  const still = accessRow("GitHub · octo@example.com");
  // Storage settles before the row re-renders: wait for the row itself.
  await still.findByText("0 bound");
  await userEvent.click(still.getByRole("button", { name: "Configure" }));
  await userEvent.click(
    within(
      screen.getByRole("group", {
        name: "Configure GitHub · octo@example.com",
      }),
    ).getByLabelText(/Enabled/),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("heading", { name: "No connector access" });
});

it("cancelling the chosen connector's form returns the keyboard to its choice", async () => {
  const fixture = await seeded();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  const choice = screen.getByRole("button", { name: /Slack/ });
  await userEvent.click(choice);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Identity")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(choice));
});

it("one bind form at a time: a row's Bind closes the choices", async () => {
  const fixture = await granted();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  await userEvent.click(
    screen.getByRole("button", { name: "Add connector access" }),
  );
  await userEvent.click(screen.getByRole("button", { name: /Slack/ }));
  expect(screen.getAllByLabelText("Identity")).toHaveLength(1);
  await userEvent.click(screen.getByRole("treeitem", { name: /GitHub/ }));
  await userEvent.click(
    accessRow("GitHub · octo@example.com").getByRole("button", {
      name: "Bind",
    }),
  );
  expect(
    screen.queryByRole("group", { name: "Add connector access" }),
  ).toBeNull();
  expect(screen.getAllByLabelText("Identity")).toHaveLength(1);
});
