import { vercelConnectCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

// The catalog mounts `connections.catalog` and `.provider-picker`,
// which `connectors.external` declares when it activates (ADR 0130).
declareConnectionsTutorial();

it("keeps browse-catalog tiles out of sequential Tab order", () => {
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel providers={vercelConnectCatalog()} />
    </MemoryRouter>,
  );
  const tiles = [
    ...container.querySelectorAll<HTMLAnchorElement>("a.conn-tile__link"),
  ];
  expect(container.querySelectorAll(".conn-tile").length).toBeGreaterThan(100);
  expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) expect(tile.tabIndex).toBe(-1);
  // Nothing leads to a page that does not exist: the catalog's own tiles are
  // its only links.
  expect(screen.queryByRole("link", { name: "Custom connector" })).toBeNull();
  const stripe = container.querySelector("#catalog-stripe");
  // This fixture has no activated Stripe credential driver, so its tile has
  // no link and names that missing verification route with a StatusMark.
  expect(stripe?.querySelector("a")).toBeNull();
  const blocked = stripe?.querySelector(".conn-tile__go title");
  expect(blocked?.textContent).toBe("No way to check a key");
  expect(stripe?.textContent).not.toMatch(/Not connectable/);
});
