import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
/** @vitest-environment jsdom */
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, expect, it } from "vitest";
import { createKeymapHandler } from "../lib/keymap.js";
import { curatedCatalogProviders } from "../sections/connections/catalog-selection.js";
import {
  ConnectionsNavigation,
  resetConnectionsNavigation,
  usePublishConnections,
} from "./ConnectionsNavigation.js";
import { ConnectionsTreeEntries } from "./ConnectionsTree.js";
import { IconConnection } from "./Icons.js";
import { SectionRow } from "./RailRows.js";
import { setRailCursor } from "./rail-cursor.js";
import { useRailKeyboard } from "./useRailKeyboard.js";

const CONNECTIONS_SECTION = {
  id: "connections",
  to: "/connections",
  label: "Connections",
  segment: "connections",
  guide: "nav.vault",
  jump: "c",
  order: 20,
  Icon: IconConnection,
};

const curated = curatedCatalogProviders(
  mergeVercelCatalog(getBundledProviders()),
).slice(0, 29);
if (curated.length < 29) throw new Error("Expected 29 curated connectors");
const providers: Provider[] = curated.map((provider, index) => ({
  ...provider,
  displayName: `Connector ${String(index).padStart(2, "0")}`,
}));
const firstProviderId = providers[0]?.id ?? "linear";

function connection(
  id: string,
  status: Connection["status"] = "active",
): Connection {
  return {
    connectionId: id,
    connectionRef: `conn/${id}`,
    logicalName: id,
    displayName: id,
    providerId: firstProviderId,
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
        <SectionRow
          section={CONNECTIONS_SECTION}
          open={open}
          active={location.pathname.startsWith("/connections")}
          branch={open}
          onToggle={() => setOpen(!open)}
        />
        {open ? <ConnectionsTreeEntries pathname={location.pathname} /> : null}
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

function group(id: string) {
  const element = document.getElementById(`${id}-tree`);
  if (!element) throw new Error(`Missing ${id} subtree`);
  return element;
}

function catalogGroup() {
  return within(group("catalog"));
}

function openCatalog() {
  const add = screen.getByRole("treeitem", { name: "Add a connection" });
  if (add.getAttribute("aria-expanded") === "false") fireEvent.click(add);
}

function openConnected() {
  const connected = screen.getByRole("treeitem", { name: "Connected" });
  if (connected.getAttribute("aria-expanded") === "false") {
    fireEvent.click(connected);
  }
}

function catalogLeaves() {
  return catalogGroup()
    .getAllByRole("treeitem")
    .filter(
      (row) =>
        row.getAttribute("aria-level") === "3" &&
        !/^Load .* more$/.test(row.textContent ?? ""),
    );
}

afterEach(() => {
  setRailCursor(null);
  cleanup();
  resetConnectionsNavigation();
});

it("lists the flat catalog 12 at a time and resets pagination", () => {
  setup();
  openCatalog();
  expect(catalogLeaves()).toHaveLength(12);
  while (screen.queryByRole("treeitem", { name: /Load .* more/ })) {
    fireEvent.click(screen.getByRole("treeitem", { name: /Load .* more/ }));
  }
  expect(catalogLeaves().length).toBeGreaterThan(12);
  expect(screen.queryByRole("treeitem", { name: /Load .* more/ })).toBeNull();
  fireEvent.click(catalogLeaves()[0]);
  expect(screen.getByLabelText("Current route").textContent).toMatch(
    /^\/connections\//,
  );
});

it("draws one catalog list without former category subheaders", () => {
  setup();
  openCatalog();
  expect(
    catalogGroup().queryByRole("treeitem", { name: "Developer tools" }),
  ).toBeNull();
  expect(
    catalogGroup().queryByRole("treeitem", { name: "Productivity" }),
  ).toBeNull();
  expect(catalogLeaves()[0]?.getAttribute("aria-level")).toBe("3");
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
    `/connections/${firstProviderId}/region-b`,
  );
  expect(row.getAttribute("aria-selected")).toBe("true");
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

it("does not list automatically configured providers as addable connectors", async () => {
  const automatic = providers[0];
  if (!automatic) throw new Error("Expected an automatic catalog fixture");
  setup([{ ...automatic, autoConfigurable: true }]);
  openCatalog();
  await waitFor(() => {
    expect(
      catalogGroup().queryByRole("treeitem", {
        name: automatic.displayName,
      }),
    ).toBeNull();
    expect(catalogLeaves().length).toBeGreaterThan(0);
  });
});
