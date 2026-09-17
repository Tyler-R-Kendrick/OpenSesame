/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { vercelConnectCatalog } from "../../lib/vercel-connect-catalog.js";
import { CatalogPanel } from "./CatalogPanel.js";

it("keeps browse-catalog tiles out of sequential Tab order", () => {
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel providers={vercelConnectCatalog()} />
    </MemoryRouter>,
  );
  const tiles = [
    ...container.querySelectorAll<HTMLAnchorElement>(".conn-tile__link"),
  ];
  expect(tiles.length).toBeGreaterThan(100);
  for (const tile of tiles) expect(tile.tabIndex).toBe(-1);
  expect(screen.getByRole("link", { name: "Custom connector" }).tabIndex).toBe(
    0,
  );
});
