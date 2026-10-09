import {
  connectRoadSeams,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import {
  type Connection,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import {
  createLocalShare,
  listLocalShares,
} from "@opensesame/app-core/lib/local-share-grants.js";
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

/** A connector configured on the Connections page (here, on Vercel Connect). */
const slack: Connection = {
  connectionId: "scn_slack",
  connectionRef: "connect://scn_slack",
  logicalName: "slack",
  displayName: "Slack",
  providerId: "slack",
  integrationId: null,
  status: "active",
  statusDetail: null,
  organizationId: "org_1",
  projectId: null,
  ownerKind: "user",
  shareability: "private",
  requestedScopes: [],
  grantedScopes: [],
  accountLabel: null,
  expiresAt: null,
  refreshable: false,
  lastRefreshedAt: null,
  maxInvokeLevel: 1,
  egress: { scheme: "https", authorities: [], pathPrefixes: [] },
  bindings: [],
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};

const originalList = connectionSeams.listConnections;

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  connectionSeams.listConnections = vi.fn(async () => [slack]);
});

afterEach(() => {
  cleanup();
  resetConnectRoadSeams();
  connectionSeams.listConnections = originalList;
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(tomb: string) {
  return render(
    <MemoryRouter>
      <ConnectorsPanel tomb={tomb} />
    </MemoryRouter>,
  );
}

it("lists a Connections-page connector someone holds, and links back to it", async () => {
  connectRoadSeams.pagesOpen = () => true;
  const fixture = await localRequestFixture();
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "host:scn_slack",
    resourceLabel: "Slack",
    policy: "use",
    durationSeconds: 3600,
  });
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  expect(screen.queryByLabelText("Directory endpoint")).toBeNull();
  const scoped = within(screen.getByRole("list", { name: "Connector access" }));
  expect(scoped.getByRole("button", { name: "Configure" })).toBeTruthy();
  expect(
    scoped
      .getByRole("link", { name: "Open in Connections" })
      .getAttribute("href"),
  ).toBe("/connections/slack/scn_slack");
});

it("offers no link back while Connections is off: its pages are not routed", async () => {
  const fixture = await localRequestFixture();
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "host:scn_slack",
    resourceLabel: "Slack",
    policy: "use",
    durationSeconds: 3600,
  });
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  const scoped = within(screen.getByRole("list", { name: "Connector access" }));
  expect(scoped.getByRole("button", { name: "Configure" })).toBeTruthy();
  expect(
    scoped.queryByRole("link", { name: "Open in Connections" }),
  ).toBeNull();
});

it("grants a Connections-page connector from Add, on the one share ledger", async () => {
  const fixture = await localRequestFixture();
  mount(fixture.tomb);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add connector access" }),
  );
  await userEvent.click(screen.getByRole("button", { name: /Slack/ }));
  const form = screen.getByRole("group", { name: /^Bind Slack/ });
  await userEvent.click(within(form).getByRole("button", { name: "Bind" }));
  await waitFor(() => expect(screen.getByText("1 bound")).toBeTruthy());
  const shares = await listLocalShares(fixture.tomb);
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceKind).toBe("connection");
  expect(shares[0]?.resourceId).toBe("host:scn_slack");
  expect(shares[0]?.resourceLabel).toBe("Slack");
});

it("lists a provider-wide grant on the connection it covers, and revokes it there", async () => {
  const fixture = await localRequestFixture();
  // Keyed by provider id — the standing grants' shape — not by connection.
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "slack",
    resourceLabel: "Slack",
    policy: "use",
    durationSeconds: 3600,
  });
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  const bound = within(
    await screen.findByRole("list", { name: /Bound to Slack/ }),
  );
  expect(bound.getByText("all Slack")).toBeTruthy();
  expect(screen.getByText("1 bound")).toBeTruthy();
  await userEvent.click(bound.getByRole("button", { name: "Revoke" }));
  await userEvent.click(bound.getByRole("button", { name: "Confirm revoke" }));
  await screen.findByRole("heading", { name: "No connector access" });
  expect(await listLocalShares(fixture.tomb)).toHaveLength(0);
});

it("lists access whose connector is not listed here, so it can be revoked", async () => {
  const fixture = await localRequestFixture();
  // A standing grant, keyed by provider, with no GitHub connection here.
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "github",
    resourceLabel: "GitHub",
    policy: "use",
    durationSeconds: 3600,
  });
  // A grant on a connector that was removed from Connections.
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "host:scn_gone",
    resourceLabel: "Linear",
    policy: "use",
    durationSeconds: 3600,
  });
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "GitHub" });
  expect(
    screen.queryByRole("heading", { name: "No connector access" }),
  ).toBeNull();
  const list = within(screen.getByRole("list", { name: "Connector access" }));
  expect(list.getByText("github · every connection")).toBeTruthy();
  expect(list.getByRole("heading", { name: "Linear" })).toBeTruthy();
  expect(list.getByLabelText("Not configured")).toBeTruthy();
  // Nothing here to bind it to or configure: only its grants' Revoke.
  const linear = list.getByRole("heading", { name: "Linear" }).closest("li");
  if (!linear) throw new Error("no row for Linear");
  expect(within(linear).queryByRole("button", { name: "Bind" })).toBeNull();
  expect(
    within(linear).queryByRole("button", { name: "Configure" }),
  ).toBeNull();
  // Slack is configured but nobody holds it: not listed.
  expect(list.queryByRole("heading", { name: "Slack" })).toBeNull();

  for (const name of ["GitHub", "Linear"]) {
    const rows = within(screen.getByRole("list", { name: "Connector access" }));
    const item = rows.getByRole("heading", { name }).closest("li");
    if (!item) throw new Error(`no row for ${name}`);
    const revoke = within(item).getByRole("button", { name: "Revoke" });
    await userEvent.click(revoke);
    await userEvent.click(within(item).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name })).toBeNull(),
    );
  }
  await screen.findByRole("heading", { name: "No connector access" });
  const left = await listLocalShares(fixture.tomb);
  expect(left.filter((share) => share.resourceKind === "connection")).toEqual(
    [],
  );
});

it("a Connections list that did not answer claims nothing about its grants", async () => {
  connectionSeams.listConnections = vi.fn(async () => {
    throw new Error("unreachable");
  });
  const fixture = await localRequestFixture();
  await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "connection",
    resourceId: "host:scn_slack",
    resourceLabel: "Slack",
    policy: "use",
    durationSeconds: 3600,
  });
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  const list = within(screen.getByRole("list", { name: "Connector access" }));
  expect(list.queryByLabelText("Not configured")).toBeNull();
  expect(list.getByRole("button", { name: "Revoke" })).toBeTruthy();
});
