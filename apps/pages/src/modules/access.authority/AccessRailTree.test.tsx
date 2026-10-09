/** @vitest-environment jsdom */
import {
  accessBookSeams,
  addLocalGrant,
  removeLocalGrant,
} from "@opensesame/app-core/lib/access-book.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { registerLegacyShell } from "../../components/legacy-sections.test-support.js";
import { setRailCursor } from "../../components/rail-cursor.js";
import * as shareLeaves from "../../sections/access/share-leaves.js";
import { AccessRailTree } from "./AccessRailTree.js";

import {
  ACCESS_LABELS,
  ACCESS_VIEWS,
} from "@opensesame/app-core/lib/section-view-names.js";
// The Access section's rail entries, as `access.authority` contributes
// them: the shell draws the section row; this is what opens beneath it.
let revokeShell = () => {};
beforeAll(() => {
  revokeShell = registerLegacyShell();
});
afterAll(() => revokeShell());

function Page() {
  const location = useLocation();
  return (
    <>
      <AccessRailTree pathname={location.pathname} />
      <output aria-label="Current route">
        {location.pathname + location.search + location.hash}
      </output>
    </>
  );
}

function setup(entry = "/access") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Page />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

it("lists every Access tab as a subtree of that tab's page panels", () => {
  setup();
  expect(
    screen
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("aria-level") === "2")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual(ACCESS_VIEWS.map((id) => ACCESS_LABELS[id]));
  // Every tab is the same kind of row, so no tab is drawn one indent in
  // from its sibling and read as its child.
  for (const id of ACCESS_VIEWS) {
    const row = screen.getByRole("treeitem", { name: ACCESS_LABELS[id] });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".railtree__caret")).toBeTruthy();
  }
  expect(document.getElementById("grants-tree")).toBeNull();
  fireEvent.click(screen.getByRole("treeitem", { name: "Grants" }));
  expect(document.getElementById("grants-tree")).toBeTruthy();
  const panel = screen.getByRole("treeitem", {
    name: "Local application grants",
  });
  expect(panel.getAttribute("aria-level")).toBe("3");
  // A panel with nothing to list is a place to jump to, not a caret onto nothing.
  expect(panel.getAttribute("aria-expanded")).toBeNull();
  expect(
    screen
      .getByRole("treeitem", { name: "Identity shares" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  // Opening another tab lists its panels beside Grants', not under them.
  fireEvent.click(screen.getByRole("treeitem", { name: "Requests" }));
  expect(
    screen
      .getByRole("treeitem", { name: "Local requests" })
      .getAttribute("aria-level"),
  ).toBe("3");
  expect(
    screen
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("aria-level") === "2")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual(ACCESS_VIEWS.map((id) => ACCESS_LABELS[id]));
});

it("navigates tab subtrees through the same view query as the page tabs", () => {
  setup("/access?view=grants");
  fireEvent.click(screen.getByRole("treeitem", { name: "Sessions" }));
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/access?view=sessions",
  );
  expect(
    screen
      .getByRole("treeitem", { name: "Sessions" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.getElementById("sessions-tree")).toBeTruthy();
});

it("navigates a tab's page panel through the tab subtree", () => {
  setup("/access?view=grants");
  fireEvent.click(screen.getByRole("treeitem", { name: "Grants" }));
  fireEvent.click(
    screen.getByRole("treeitem", { name: "Local application grants" }),
  );
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/access?view=grants#local-grants",
  );
  expect(
    screen
      .getByRole("treeitem", { name: "Local application grants" })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

it("collapses the selected tab subtree and keeps the Access view", () => {
  setup("/access?view=grants");
  const grants = screen.getByRole("treeitem", { name: "Grants" });
  fireEvent.click(grants);
  fireEvent.click(grants);
  expect(grants.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("grants-tree")).toBeNull();
  expect(screen.getByLabelText("Current route").textContent).toBe(
    "/access?view=grants",
  );
});

it("lists Portable grants while the access book holds one, and only then", () => {
  const original = { ...accessBookSeams };
  let stored: string | null = null;
  Object.assign(accessBookSeams, {
    read: () => stored,
    write: (raw: string) => {
      stored = raw;
    },
  });
  try {
    setup("/access?view=grants");
    fireEvent.click(screen.getByRole("treeitem", { name: "Grants" }));
    expect(
      screen.queryByRole("treeitem", { name: "Portable grants" }),
    ).toBeNull();
    let id = "";
    act(() => {
      id = addLocalGrant({ title: "Nightly deploy" }).id;
    });
    // The rail follows the book without a remount, as the page's panel does.
    expect(
      screen.getByRole("treeitem", { name: "Portable grants" }),
    ).toBeTruthy();
    act(() => removeLocalGrant(id));
    expect(
      screen.queryByRole("treeitem", { name: "Portable grants" }),
    ).toBeNull();
  } finally {
    Object.assign(accessBookSeams, original);
  }
});

it("scrolls to a panel already named in the address when its row is clicked again", () => {
  const scrollBy = vi.fn();
  vi.stubGlobal("scrollBy", scrollBy);
  const panel = document.createElement("section");
  panel.id = "local-grants";
  document.body.append(panel);
  try {
    setup("/access?view=grants#local-grants");
    fireEvent.click(screen.getByRole("treeitem", { name: "Grants" }));
    // The link is the current address, so it navigates nowhere; the row
    // still takes the reader to the panel.
    fireEvent.click(
      screen.getByRole("treeitem", { name: "Local application grants" }),
    );
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Current route").textContent).toBe(
      "/access?view=grants#local-grants",
    );
  } finally {
    panel.remove();
    vi.unstubAllGlobals();
  }
});

it("marks the share leaf for canonical and legacy record addresses", async () => {
  const leafId = "11111111-1111-4111-8111-111111111111";
  const canonical = `/access?view=grants#identity-shares/${leafId}`;
  const legacy = `/access?view=grants#share-${leafId}`;
  const shares = vi
    .spyOn(shareLeaves, "useShareLeaves")
    .mockReturnValue([{ id: leafId, label: "Owner → personal" }]);
  try {
    render(
      <MemoryRouter initialEntries={["/access?view=grants"]}>
        <Page />
        <Link to={canonical}>Canonical share</Link>
        <Link to={legacy}>Legacy share</Link>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("treeitem", { name: "Grants" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Identity shares" }));
    // The shell clears its separate keyboard cursor when a page link moves the route.
    act(() => setRailCursor(null));
    fireEvent.click(screen.getByRole("link", { name: "Canonical share" }));
    const leaf = screen.getByRole("treeitem", { name: "Owner → personal" });
    await waitFor(() =>
      expect(leaf.getAttribute("aria-selected")).toBe("true"),
    );
    expect(
      screen
        .getByRole("treeitem", { name: "Identity shares" })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByLabelText("Current route").textContent).toBe(canonical);
    fireEvent.click(screen.getByRole("link", { name: "Legacy share" }));
    await waitFor(() =>
      expect(leaf.getAttribute("aria-selected")).toBe("true"),
    );
  } finally {
    act(() => setRailCursor(null));
    shares.mockRestore();
  }
});
