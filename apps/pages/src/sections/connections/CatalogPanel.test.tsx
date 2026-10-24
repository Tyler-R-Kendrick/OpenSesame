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
  // An entry whose API-key preset names an authenticated check (Stripe's
  // GET /v1/balance) is connectable before External connectors activates
  // (4798795f8), so its tile opens the connection page like any other link,
  // and that link too stays out of sequential Tab order.
  const stripe = container.querySelector<HTMLAnchorElement>(
    "#catalog-stripe a.conn-tile__link",
  );
  expect(stripe?.getAttribute("href")).toBe("/connections/stripe");
  expect(stripe?.getAttribute("aria-label")).toBe("Connect Stripe");
  expect(stripe?.tabIndex).toBe(-1);
  expect(stripe?.getAttribute("aria-describedby")).toBe("catalog-stripe-tags");
  expect(container.querySelector("#catalog-stripe-tags")?.textContent).toBe(
    "API key",
  );
  // An entry with no browser road is no link at all, and says why with a
  // StatusMark glyph — the sentence is its name, not a pill. Zapier's MCP
  // preflight refuses the audited origin (spec/connectors/browser-policy.json).
  const zapier = container.querySelector("#catalog-zapier");
  expect(zapier).toBeTruthy();
  expect(zapier?.querySelector("a")).toBeNull();
  const blocked = zapier?.querySelector(".conn-tile__go title");
  expect(blocked?.textContent).toBe("Provider blocks browsers");
  expect(zapier?.textContent).not.toMatch(/Not connectable/);
});

it("offers BYO AI through the custom entry in the add builder, not a browse tile", () => {
  // #1902 put BYO first among tiles; main then retired byo-ai from
  // browse (0ca0474ca) in favor of a custom entry — now the Custom /
  // self-hosted link in the auth-method builder — so partners render
  // alphabetically without a BYO tile.
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
  const tileIds = tiles.map((tile) => tile.id);
  // The panel also synthesizes featured/family tiles; what retired
  // BYO AI guarantees is its absence and partners' alphabetical order.
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
