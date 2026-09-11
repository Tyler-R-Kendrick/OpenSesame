/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it } from "vitest";
import type { Connection, Provider } from "../lib/connections.js";
import { getBundledProviders } from "../lib/embedded-catalog.js";
import { createKeymapHandler } from "../lib/keymap.js";
import {
  ConnectionsNavigation,
  usePublishConnections,
} from "./ConnectionsNavigation.js";
import { ConnectionsTree } from "./ConnectionsTree.js";
import { setRailCursor } from "./rail-cursor.js";
import { useRailKeyboard } from "./useRailKeyboard.js";

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
  const treeRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const currentToRef = useRef(location.pathname + location.hash);
  currentToRef.current = location.pathname + location.hash;
  useRailKeyboard(treeRef, navigateRef, currentToRef);
  useEffect(() => {
    const handler = createKeymapHandler({
      navigate,
      showHelp: () => undefined,
    });
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [navigate]);
  return (
    <>
      <nav
        ref={treeRef}
        className="railtree"
        role="tree"
        aria-label="Sections"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role=tree with aria-activedescendant is the interactive element; the tab stop belongs on it
        tabIndex={0}
      >
        <ConnectionsTree open={open} onToggle={() => setOpen(!open)} />
      </nav>
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

function openConnected() {
  const connected = screen.getByRole("treeitem", { name: "Connected" });
  if (connected.getAttribute("aria-expanded") === "false") {
    fireEvent.click(connected);
  }
}

function openCatalog() {
  const add = screen.getByRole("treeitem", { name: "Add a connection" });
  if (add.getAttribute("aria-expanded") === "false") fireEvent.click(add);
}

function expandCatalogGroups() {
  openCatalog();
  for (const row of catalogGroup().getAllByRole("treeitem")) {
    if (
      row.getAttribute("aria-level") === "3" &&
      row.getAttribute("aria-expanded") === "false"
    ) {
      fireEvent.click(row);
    }
  }
}

afterEach(() => {
  setRailCursor(null);
  cleanup();
});

it("lists 12 at a time and resets pagination", () => {
  setup();
  expandCatalogGroups();
  expect(catalogLeaves()).toHaveLength(12);
  fireEvent.click(screen.getByRole("treeitem", { name: "Load 12 more" }));
  expect(catalogLeaves()).toHaveLength(24);
  fireEvent.click(screen.getByRole("treeitem", { name: "Load 5 more" }));
  expect(catalogLeaves()).toHaveLength(29);
  expect(screen.queryByRole("treeitem", { name: /Load .* more/ })).toBeNull();
  fireEvent.click(
    catalogGroup().getByRole("treeitem", { name: "Connector 28" }),
  );
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections/provider-28",
  );
});

it("walks catalog subheaders in page order instead of alphabetically", () => {
  setup([
    {
      ...template,
      id: "zulu",
      displayName: "Zulu Cloud",
      category: "developer",
      autoConfigurable: false,
    },
    {
      ...template,
      id: "alpha",
      displayName: "Alpha Cloud",
      category: "developer",
      autoConfigurable: false,
    },
    {
      ...template,
      id: "mid",
      displayName: "Mid Pass",
      category: "password_managers",
      autoConfigurable: false,
    },
  ]);
  expandCatalogGroups();
  expect(
    catalogGroup()
      .getAllByRole("treeitem")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual([
    "Password managers",
    "Mid Pass",
    "Developer tools",
    "Zulu Cloud",
    "Alpha Cloud",
  ]);
});

it("keeps each connected instance addressable and excludes revoked connections", () => {
  setup();
  openConnected();
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
  openConnected();
  expect(screen.getByRole("treeitem", { name: "region-b" })).toBeTruthy();
});

it("toggles both subtrees and navigates to their page anchors", () => {
  setup();
  const connected = screen.getByRole("treeitem", { name: "Connected" });
  expect(connected.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(connected);
  expect(connected.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(connected);
  expect(connected.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("connected-tree")).toBeNull();
  fireEvent.click(connected);
  expect(connected.getAttribute("aria-expanded")).toBe("true");
  expect(group("connected")).toBeTruthy();

  const catalog = screen.getByRole("treeitem", { name: "Add a connection" });
  expect(catalog.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(catalog);
  expect(catalog.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections#catalog",
  );
  expect(group("catalog")).toBeTruthy();
  fireEvent.click(catalog);
  expect(catalog.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("catalog-tree")).toBeNull();
});

it("does not index the catalog while a group is collapsed", () => {
  setup();
  openCatalog();
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections#catalog",
  );
  const tree = screen.getByRole("tree", { name: "Sections" });
  tree.focus();
  fireEvent.keyDown(window, { key: "ArrowDown", bubbles: true });
  const groupRow = catalogGroup()
    .getAllByRole("treeitem")
    .find((row) => row.getAttribute("aria-expanded") === "false");
  expect(groupRow?.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/connections#catalog",
  );
});

it("indexes catalog leaves once their group is expanded", () => {
  setup();
  openCatalog();
  const groupRow = catalogGroup()
    .getAllByRole("treeitem")
    .find((row) => row.getAttribute("aria-expanded") === "false");
  fireEvent.click(groupRow as HTMLElement);
  const tree = screen.getByRole("tree", { name: "Sections" });
  tree.focus();
  fireEvent.keyDown(window, { key: "ArrowDown", bubbles: true });
  expect(screen.getByLabelText("Current route").textContent).toMatch(
    /#catalog-provider-/,
  );
});

it("keeps nested catalog groups collapsed until they are opened", () => {
  setup();
  openCatalog();
  const groupRow = catalogGroup()
    .getAllByRole("treeitem")
    .find((row) => row.getAttribute("aria-expanded") === "false");
  expect(groupRow).toBeTruthy();
  expect(catalogLeaves()).toHaveLength(0);
  fireEvent.click(groupRow as HTMLElement);
  expect(groupRow?.getAttribute("aria-expanded")).toBe("true");
  expect(catalogLeaves().length).toBeGreaterThan(0);
});

it("distinguishes a loading catalog from an empty catalog", () => {
  const view = setup(null);
  openCatalog();
  expect(screen.getByText("Loading connectors…")).toBeTruthy();
  view.unmount();
  setup([]);
  openCatalog();
  expect(screen.getByText("No matching connectors")).toBeTruthy();
});

it("does not list automatically configured providers as addable connectors", () => {
  setup([{ ...providers[0], autoConfigurable: true }]);
  openCatalog();
  expect(catalogGroup().queryAllByRole("treeitem")).toHaveLength(0);
});

function group(id: string) {
  const element = document.getElementById(`${id}-tree`);
  if (!element) throw new Error(`Missing ${id} subtree`);
  return element;
}

function catalogLeaves() {
  return catalogGroup()
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("aria-level") === "4");
}
