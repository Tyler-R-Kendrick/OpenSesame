import { vercelConnectCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";

it.skip("keeps browse-catalog tiles out of sequential Tab order", () => {
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel providers={vercelConnectCatalog()} />
    </MemoryRouter>,
  );
  const tiles = [
    ...container.querySelectorAll<HTMLAnchorElement>("a.conn-tile__link"),
  ];
  expect(tiles.length).toBeGreaterThan(100);
  for (const tile of tiles) expect(tile.tabIndex).toBe(-1);
  expect(screen.getByRole("link", { name: "Custom connector" }).tabIndex).toBe(
    0,
  );
  const stripe = container.querySelector("#catalog-stripe");
  expect(stripe?.querySelector("a")).toBeNull();
  expect(stripe?.textContent).toMatch(/Not connectable/);
});
