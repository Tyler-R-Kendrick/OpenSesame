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
  const byoAi = container.querySelector("#catalog-byo-ai");
  // BYO AI has a complete configuration contract available to a guest.
  const byoAiLink = screen.getByRole("link", { name: "Connect BYO AI" });
  expect(byoAi?.querySelector("a")).toBe(byoAiLink);
  expect(byoAiLink.getAttribute("href")).toBe("/connections/byo-ai");
  expect(byoAiLink.getAttribute("aria-describedby")).toBe(
    "catalog-byo-ai-tags",
  );
  expect(byoAiLink.tabIndex).toBe(-1);
  const blocked = byoAi?.querySelector(".conn-tile__go title");
  expect(blocked).toBeNull();
  expect(byoAi?.textContent).not.toMatch(/Not connectable/);
});

it("puts BYO AI first and keeps partner tiles alphabetical", () => {
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
  expect(tiles[0]?.id).toBe("catalog-byo-ai");
  expect(
    tiles
      .map((tile) => tile.id)
      .filter((id) =>
        ["catalog-byo-ai", "catalog-anthropic", "catalog-openai"].includes(id),
      ),
  ).toEqual(["catalog-byo-ai", "catalog-anthropic", "catalog-openai"]);
  const byo = container.querySelector("#catalog-byo-ai");
  expect(byo?.querySelector("a")?.getAttribute("href")).toBe(
    "/connections/byo-ai",
  );
  expect(byo?.querySelector(".conn-tag--method")?.textContent).toBe(
    "Configuration",
  );
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
