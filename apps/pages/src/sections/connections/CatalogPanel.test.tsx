import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
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
  expect(container.querySelectorAll(".conn-tile").length).toBeGreaterThan(0);
  expect(tiles.length).toBeGreaterThan(0);
  expect(container.querySelectorAll(".conn-group__label")).toHaveLength(0);
  expect(
    container.querySelectorAll(".conn-tile__tags .conn-tag").length,
  ).toBeGreaterThan(0);
  const linearLink = container.querySelector<HTMLAnchorElement>(
    "#catalog-linear a.conn-tile__link",
  );
  expect(linearLink).toBeTruthy();
  expect(linearLink?.getAttribute("aria-describedby")).toBe(
    "catalog-linear-tags",
  );
  expect(container.querySelector("#catalog-linq")).toBeNull();
  expect(container.querySelector("#catalog-whoop")).toBeNull();
  for (const tile of tiles) expect(tile.tabIndex).toBe(-1);
  // Nothing leads to a page that does not exist: the catalog's own tiles are
  // its only links.
  expect(screen.queryByRole("link", { name: "Custom connector" })).toBeNull();
  const stripe = container.querySelector("#catalog-stripe");
  // A catalog entry Vercel Connect cannot broker is no link at all, and says
  // so with a StatusMark glyph — the sentence is its name, not a pill.
  expect(stripe?.querySelector("a")).toBeNull();
  const blocked = stripe?.querySelector(".conn-tile__go title");
  expect(blocked?.textContent).toBe("No way to check a key");
  expect(stripe?.textContent).not.toMatch(/Not connectable/);
});

it("renders BYO AI as the first selectable catalog tile before alphabetical partners", () => {
  const ids = new Set(["openai", "anthropic", "byo-ai"]);
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel
        providers={getBundledProviders().filter((provider) =>
          ids.has(provider.id),
        )}
      />
    </MemoryRouter>,
  );
  const tiles = [...container.querySelectorAll(".conn-grid > .conn-tile")];
  expect(tiles.map((tile) => tile.id)).toEqual([
    "catalog-byo-ai",
    "catalog-anthropic",
    "catalog-openai",
  ]);
  expect(tiles[0]?.querySelector("a")?.getAttribute("href")).toBe(
    "/connections/byo-ai",
  );
  expect(tiles[0]?.querySelector(".conn-tile__name")?.textContent).toBe(
    "BYO AI",
  );
  expect(tiles[0]?.querySelector(".conn-tile__tags")?.textContent).toBe("AI");
});
