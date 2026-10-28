import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

// The catalog mounts `connections.catalog` and `.provider-picker`,
// which `connectors.external` declares when it activates (ADR 0130).
declareConnectionsTutorial();
afterEach(cleanup);

it("keeps browse-catalog tiles out of sequential Tab order", () => {
  const { container } = render(
    <MemoryRouter>
      <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
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
  // Stripe has a bounded balance check, so its tile opens real configuration.
  const stripeLink = screen.getByRole("link", { name: "Connect Stripe" });
  expect(stripe?.querySelector("a")).toBe(stripeLink);
  expect(stripeLink.getAttribute("href")).toBe("/connections/stripe");
  expect(stripeLink.getAttribute("aria-describedby")).toBe(
    "catalog-stripe-tags",
  );
  expect(stripeLink.tabIndex).toBe(-1);
  const blocked = stripe?.querySelector(".conn-tile__go title");
  expect(blocked).toBeNull();
  expect(stripe?.textContent).not.toMatch(/No way to check a key/);
  expect(stripe?.textContent).not.toMatch(/Not connectable/);
});

it("offers BYO AI through the custom entry in the add builder, not a browse tile", () => {
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
  const tileIds = [
    ...container.querySelectorAll(".conn-grid > .conn-tile"),
  ].map((tile) => tile.id);
  expect(tileIds).not.toContain("catalog-byo-ai");
  expect(tileIds.indexOf("catalog-anthropic")).toBeGreaterThanOrEqual(0);
  expect(tileIds.indexOf("catalog-anthropic")).toBeLessThan(
    tileIds.indexOf("catalog-openai"),
  );
  expect(container.querySelector("#catalog-byo-ai")).toBeNull();
});

it("links the + button to the custom connector form", () => {
  render(
    <MemoryRouter>
      <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
    </MemoryRouter>,
  );
  const add = screen.getByRole("link", { name: "Add a custom connection" });
  expect(add.getAttribute("href")).toBe("/connections/custom-oidc");
});
