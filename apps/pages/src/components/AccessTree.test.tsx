/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it } from "vitest";
import { ACCESS_LABELS, ACCESS_VIEWS } from "../lib/section-views.js";
import { AccessTree } from "./AccessTree.js";

function Page() {
  const location = useLocation();
  const [open, setOpen] = useState(true);
  return (
    <>
      <AccessTree
        open={open}
        active={location.pathname.startsWith("/access")}
        onToggle={() => setOpen((previous) => !previous)}
      />
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
  const grants = screen.getByRole("treeitem", { name: "Grants" });
  expect(grants.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById("grants-tree")).toBeNull();
  expect(
    screen.getByRole("treeitem", { name: "Requests" }).getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(grants);
  expect(document.getElementById("grants-tree")).toBeTruthy();
  expect(
    screen
      .getByRole("treeitem", { name: "Local application grants" })
      .getAttribute("aria-level"),
  ).toBe("3");
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
