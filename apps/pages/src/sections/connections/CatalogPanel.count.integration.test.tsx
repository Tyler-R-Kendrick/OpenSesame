/** @vitest-environment jsdom */
import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { catalogTileId } from "./catalog-families.js";
import { curatedCatalogProviders } from "./catalog-selection.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";
declareConnectionsTutorial();
afterEach(cleanup);

const providers = mergeVercelCatalog(getBundledProviders());

function drawTiles() {
  render(
    <MemoryRouter>
      <CatalogPanel providers={providers} />
    </MemoryRouter>,
  );
  return [...document.querySelectorAll("#catalog .conn-tile")].map((tile) =>
    decodeURIComponent(tile.id.replace(/^catalog-/, "")),
  );
}

it("counts the exact rendered merged-catalog tiles, including refused and unavailable entries", () => {
  const tiles = drawTiles();
  const listed = curatedCatalogProviders(providers, {
    includeFeatured: true,
    includeFamilies: true,
  });
  expect(tiles).toHaveLength(listed.length);
  expect([...tiles].sort()).toEqual(
    listed.map((row) => catalogTileId(row.id)).sort(),
  );
  expect(providers.length).toBeGreaterThan(listed.length);
  expect(tiles.length).toBeGreaterThan(0);
});

/**
 * A tile names a row of the one definition (ADR 0139): the connector catalog,
 * or a Connect service (`spec/connectors/connect-services.json`, ADR 0147).
 */
it("names every drawn tile by a row of the connector catalog (ADR 0139)", () => {
  const undefinedRows = drawTiles().filter(
    (id) => canonicalProviderId(id) === undefined && !hasConnectPlan(id),
  );
  expect(undefinedRows).toEqual([]);
});
