import {
  type Connection,
  connectionSeams,
} from "@opensesame/app-core/lib/connections.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
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

it("lists the connectors the Connections page configured, with no directory and no Host", async () => {
  const fixture = await localRequestFixture();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  // Connections-page connectors need no directory, so its form stays shut.
  expect(screen.queryByLabelText("Directory endpoint")).toBeNull();
  const scoped = within(screen.getByRole("listitem"));
  expect(scoped.getByRole("button", { name: "Configure" })).toBeTruthy();
  expect(
    scoped
      .getByRole("link", { name: "Open in Connections" })
      .getAttribute("href"),
  ).toBe("/connections/slack/scn_slack");
});

it("binds a Connections-page connector on the one share ledger", async () => {
  const fixture = await localRequestFixture();
  mount(fixture.tomb);
  await screen.findByRole("heading", { name: "Slack" });
  const row = within(screen.getByRole("listitem"));
  await userEvent.click(row.getByRole("button", { name: "Bind" }));
  const form = screen.getByRole("group", { name: /^Bind Slack/ });
  await userEvent.click(within(form).getByRole("button", { name: "Bind" }));
  await waitFor(() => expect(row.getByText("1 bound")).toBeTruthy());
  const shares = await listLocalShares(fixture.tomb);
  expect(shares).toHaveLength(1);
  expect(shares[0]?.resourceKind).toBe("connection");
  expect(shares[0]?.resourceId).toBe("host:scn_slack");
  expect(shares[0]?.resourceLabel).toBe("Slack");
});
