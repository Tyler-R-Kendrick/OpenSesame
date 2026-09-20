/** @vitest-environment jsdom */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  syncConnectorDirectory,
} from "../../lib/connector-directory.js";
import { kvDelete } from "../../lib/kv.js";
import { localRequestFixture } from "../../lib/local-request.fixture.js";
import { listLocalShares } from "../../lib/local-share-grants.js";
import type { DirectoryConnection } from "../../lib/nango-directory.js";
import { lockAllTombs } from "../../lib/vfs.js";
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

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github, slack],
  }));
});

afterEach(() => {
  cleanup();
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  kvDelete("connector-directory.v1");
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seeded() {
  const fixture = await localRequestFixture();
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: fixture.tomb,
  });
  return fixture;
}

it.skip("lists the directory's connectors with their source and health", async () => {
  const fixture = await seeded();
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  expect(
    screen.getByText(/^api\.nango\.dev · 2 connectors · synced /),
  ).toBeTruthy();
  const rows = screen.getAllByRole("listitem");
  // SAFETY: fixture constructed in this test matches the declared contract.
  expect(within(rows[0] as HTMLElement).getByText("Authorized")).toBeTruthy();
  // SAFETY: fixture constructed in this test matches the declared contract.
  expect(within(rows[1] as HTMLElement).getByText("1 error")).toBeTruthy();
  // One source only: a chip on every row would say nothing.
  expect(screen.queryByText("directory")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("asks for a directory, and nothing else, when none has been synced", async () => {
  const fixture = await localRequestFixture();
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByLabelText("Directory endpoint");
  expect(screen.getByLabelText("Environment key")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sync connectors" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/could not|failed|went wrong/i)).toBeNull();
});

it("binds a connector to a person under a policy, lists it, and revokes it", async () => {
  const fixture = await seeded();
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  const [githubRow] = screen.getAllByRole("listitem");
  // SAFETY: fixture constructed in this test matches the declared contract.
  const row = within(githubRow as HTMLElement);
  await userEvent.click(row.getByRole("button", { name: "Bind" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Identity"));
  // The form carries the verb while it is open; the row's Bind steps aside.
  expect(row.getAllByRole("button", { name: "Bind" })).toHaveLength(1);
  await userEvent.selectOptions(screen.getByLabelText("Policy"), "Invoke");
  await userEvent.selectOptions(screen.getByLabelText("Duration"), "1 day");
  const form = screen.getByRole("group", { name: /^Bind GitHub/ });
  await userEvent.click(within(form).getByRole("button", { name: "Bind" }));
  await waitFor(() =>
    expect(row.getByRole("list", { name: /Bound to/ })).toBeTruthy(),
  );
  expect(row.getByText("Test person")).toBeTruthy();
  expect(row.getByText("Invoke")).toBeTruthy();
  expect(row.getByText("1 bound")).toBeTruthy();
  const shares = await listLocalShares(fixture.tomb);
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceId).toBe("nango:github/octocat");
  expect(shares[0]?.resourceLabel).toBe("GitHub · octo@example.com");
  expect(shares[0]?.policy).toBe("invoke");

  // The form is gone; the keyboard is back on the row's Bind, not on body.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      row.getByRole("button", { name: "Bind" }),
    ),
  );

  await userEvent.click(row.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(row.getByText("0 bound")).toBeTruthy());
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
});

it("returns the keyboard to the row's Bind when its form is cancelled", async () => {
  const fixture = await seeded();
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  const [githubRow] = screen.getAllByRole("listitem");
  // SAFETY: fixture constructed in this test matches the declared contract.
  const row = within(githubRow as HTMLElement);
  await userEvent.click(row.getByRole("button", { name: "Bind" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Identity"));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      row.getByRole("button", { name: "Bind" }),
    ),
  );
  expect(screen.queryByRole("group", { name: /^Bind GitHub/ })).toBeNull();
});

it("re-syncs with the sealed key from the command strip", async () => {
  const fixture = await seeded();
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github],
  }));
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByText(/· 2 connectors ·/);
  await userEvent.click(
    screen.getByRole("button", { name: "Sync the directory" }),
  );
  await screen.findByText(/· 1 connector ·/);
  expect(screen.getByRole("status").textContent).toContain(
    "1 connector synced.",
  );
  expect(connectorDirectorySeams.listDirectory).toHaveBeenCalledWith(
    "https://api.nango.dev",
    "sk-env",
  );
});

it.skip("configures a connector: alias, disable, and bind defaults", async () => {
  const fixture = await seeded();
  render(<ConnectorsPanel tomb={fixture.tomb} />);
  await screen.findByRole("heading", { name: "GitHub · octo@example.com" });
  const [githubRow] = screen.getAllByRole("listitem");
  // SAFETY: fixture constructed in this test matches the declared contract.
  const row = within(githubRow as HTMLElement);
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
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "CI mirror" })).toBeTruthy(),
  );
  expect(row.getByText("Disabled")).toBeTruthy();
  // A disabled connector refuses new binds.
  expect(
    (row.getByRole("button", { name: "Bind" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  // Its bind form opens on the configured defaults once re-enabled.
  await userEvent.click(row.getByRole("button", { name: "Configure" }));
  const reopened = screen.getByRole("group", { name: "Configure CI mirror" });
  await userEvent.click(within(reopened).getByLabelText(/Enabled/));
  await userEvent.click(within(reopened).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      (row.getByRole("button", { name: "Bind" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await userEvent.click(row.getByRole("button", { name: "Bind" }));
  expect((screen.getByLabelText("Policy") as HTMLSelectElement).value).toBe(
    "invoke",
  );
});
