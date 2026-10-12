/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { connectionsPageSources } from "./page-tree.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
declareConnectionsTutorial();
afterEach(cleanup);
it("counts the exact rendered merged-catalog tiles, including refused and unavailable entries", () => {
  const providers = mergeVercelCatalog(getBundledProviders());
  render(
    <MemoryRouter>
      <CatalogPanel providers={providers} />
    </MemoryRouter>,
  );
  const catalog = connectionsPageSources(providers, []).find(
    (source) => source.id === "catalog",
  );
  const listed =
    catalog?.sections?.flatMap((section) => section.items ?? []) ?? [];
  const tiles = [...document.querySelectorAll("#catalog .conn-tile")];
  expect(tiles).toHaveLength(listed.length);
  expect(tiles.map((tile) => tile.id).sort()).toEqual(
    listed.map((row) => `catalog-${encodeURIComponent(row.id)}`).sort(),
  );
  expect(providers.length).toBeGreaterThan(listed.length);
  expect(tiles.some((tile) => !tile.querySelector("a"))).toBe(true);
});
