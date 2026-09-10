/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it } from "vitest";
import type { Connection, Provider } from "../lib/connections.js";
import { getBundledProviders } from "../lib/embedded-catalog.js";
import {
  ConnectionsNavigation,
  usePublishConnections,
} from "./ConnectionsNavigation.js";
import { ConnectionsTree } from "./ConnectionsTree.js";

const template = getBundledProviders()[0];
if (!template) throw new Error("Bundled catalog must not be empty");
const providers: Provider[] = Array.from({ length: 29 }, (_, index) => ({
  ...template,
  id: `provider-${index}`,
  displayName: `Connector ${String(index).padStart(2, "0")}`,
  autoConfigurable: false,
}));
function connection(
  id: string,
  status: Connection["status"] = "active",
): Connection {
  return {
    connectionId: id,
    connectionRef: `conn/${id}`,
    logicalName: id,
    displayName: id,
    providerId: "provider-0",
    integrationId: null,
    status,
    statusDetail: null,
    organizationId: "org_test",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
  };
}
const connections = [
  connection("region-a"),
  connection("region-b"),
  connection("revoked", "revoked"),
];

function Page({ catalog }: { catalog: Provider[] | null }) {
  usePublishConnections(catalog, connections);
  const [open, setOpen] = useState(true);
  const location = useLocation();
  return (
    <>
      <ConnectionsTree open={open} onToggle={() => setOpen(!open)} />
      <output aria-label="Current route">
        {location.pathname + location.hash}
      </output>
    </>
  );
}
function setup(catalog: Provider[] | null = providers) {
  return render(
    <MemoryRouter initialEntries={["/connections"]}>
      <ConnectionsNavigation>
        <Page catalog={catalog} />
      </ConnectionsNavigation>
    </MemoryRouter>,
  );
}
function catalogGroup() {
  return within(group("catalog"));
}

afterEach(cleanup);

it("lists 12 at a time, searches the full catalog, and resets pagination", () => {
  setup();
  expect(catalogGroup().getAllByRole("treeitem")).toHaveLength(12);
  fireEvent.click(screen.getByRole("button", { name: "Load 12 more" }));
  expect(catalogGroup().getAllByRole("treeitem")).toHaveLength(24);
  fireEvent.click(screen.getByRole("button", { name: "Load 5 more" }));
  expect(catalogGroup().getAllByRole("treeitem")).toHaveLength(29);
  expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
  const search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: " CONNECTOR 28 " } });
  expect(catalogGroup().getAllByRole("treeitem")).toHaveLength(1);
  fireEvent.click(
    catalogGroup().getByRole("treeitem", { name: "Connector 28" }),
  );
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections/provider-28",
  );
  fireEvent.change(search, { target: { value: "no-match" } });
  expect(screen.getByText("No matching connectors")).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  expect(catalogGroup().getAllByRole("treeitem")).toHaveLength(12);
});

it("keeps each connected instance addressable and excludes revoked connections", () => {
  setup();
  const connected = within(group("connected"));
  expect(connected.getAllByRole("treeitem")).toHaveLength(2);
  const row = connected.getByRole("treeitem", { name: "region-b" });
  expect(row.getAttribute("aria-level")).toBe("3");
  fireEvent.click(row);
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections/provider-0/region-b",
  );
  expect(row.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("treeitem", { name: "Connections" }));
  expect(document.getElementById("connected-tree")).toBeNull();
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections/provider-0/region-b",
  );
  fireEvent.click(screen.getByRole("treeitem", { name: "Connections" }));
  expect(
    screen
      .getByRole("treeitem", { name: "region-b" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("toggles both subtrees and navigates to their page anchors", () => {
  setup();
  for (const [label, anchor] of [
    ["Connected", "connected"],
    ["Add a Connection", "catalog"],
  ]) {
    const branch = screen.getByRole("treeitem", { name: label });
    fireEvent.click(branch);
    expect(branch.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(`${anchor}-tree`)).toBeNull();
    expect(screen.getByLabelText("Current route").textContent).toBe(
      `/connections#${anchor}`,
    );
    fireEvent.click(branch);
    expect(branch.getAttribute("aria-expanded")).toBe("true");
    expect(group(anchor)).toBeTruthy();
  }
});

it("distinguishes a loading catalog from an empty catalog", () => {
  const view = setup(null);
  expect(screen.getByText("Loading connectors…")).toBeTruthy();
  view.unmount();
  setup([]);
  expect(screen.getByText("No matching connectors")).toBeTruthy();
});

it("does not list automatically configured providers as addable connectors", () => {
  setup([{ ...providers[0], autoConfigurable: true }]);
  expect(catalogGroup().queryAllByRole("treeitem")).toHaveLength(0);
});

function group(id: string) {
  const element = document.getElementById(`${id}-tree`);
  if (!element) throw new Error(`Missing ${id} subtree`);
  return element;
}
