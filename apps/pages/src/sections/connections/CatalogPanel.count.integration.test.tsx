/** @vitest-environment jsdom */
import { isRegistryPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { canonicalProviderId } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { CatalogPanel } from "./CatalogPanel.js";
import { curatedCatalogProviders } from "./catalog-selection.js";
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
  const listed = curatedCatalogProviders(providers, {
    includeFeatured: true,
    includeFamilies: true,
  });
  const tiles = [...document.querySelectorAll("#catalog .conn-tile")];
  expect(tiles).toHaveLength(listed.length);
  expect(tiles.map((tile) => tile.id).sort()).toEqual(
    listed.map((row) => `catalog-${encodeURIComponent(row.id)}`).sort(),
  );
  expect(providers.length).toBeGreaterThan(listed.length);
  expect(tiles.length).toBeGreaterThan(0);
});

/**
 * A tile is a row of the one integration catalog (ADR 0139), or a service
 * Vercel's Connect registry lists (ADR 0147). A provider we researched
 * ourselves is a catalog row, so every target reads the same name, category,
 * auth and egress.
 */
it("draws every tile from the integration catalog or Connect's registry", () => {
  render(
    <MemoryRouter>
      <CatalogPanel providers={mergeVercelCatalog(getBundledProviders())} />
    </MemoryRouter>,
  );
  const unlisted = [...document.querySelectorAll("#catalog .conn-tile")]
    .map((tile) => decodeURIComponent(tile.id.replace(/^catalog-/, "")))
    .filter(
      (id) => canonicalProviderId(id) === undefined && !isRegistryPlan(id),
    );
  expect(unlisted).toEqual([]);
});
