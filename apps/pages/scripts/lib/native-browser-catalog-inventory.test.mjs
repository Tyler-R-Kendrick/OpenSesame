/** @vitest-environment node */
import { expect, it } from "vitest";
import { isConnectionCatalogProvider } from "../../../../packages/app-core/src/lib/catalog-provider.ts";
import { getBundledProviders } from "../../../../packages/app-core/src/lib/embedded-catalog.ts";
import { mergeVercelCatalog } from "../../../../packages/app-core/src/lib/vercel-connect-catalog.ts";
import { curatedCatalogProviders } from "../../src/sections/connections/catalog-selection.ts";
import { catalogPageItems } from "../../src/sections/connections/page-tree.ts";
import { NATIVE_CANONICAL_CATALOG_IDS } from "./native-browser-catalog-projection.mjs";

it("requires every actual featured and family Add card in the native inventory", () => {
  const providers = mergeVercelCatalog(getBundledProviders()).filter(
    isConnectionCatalogProvider,
  );
  const rendered = curatedCatalogProviders(providers, {
    includeFeatured: true,
    includeFamilies: true,
  }).map((provider) => provider.id);
  const rail = catalogPageItems(providers).map((row) => row.id);
  // Family aliases resolve to their real canonical catalog rows in both views.
  // Researched presets also have catalog rows: no browse tile is render-only.
  expect(rendered.filter((id) => !rail.includes(id)).sort()).toEqual([]);
  expect(NATIVE_CANONICAL_CATALOG_IDS).toEqual(rendered);
  expect(new Set(NATIVE_CANONICAL_CATALOG_IDS).size).toBe(rendered.length);
  expect(rail.every((id) => NATIVE_CANONICAL_CATALOG_IDS.includes(id))).toBe(
    true,
  );
});
