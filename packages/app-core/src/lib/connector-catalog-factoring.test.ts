import { expect, it } from "vitest";
import { factorCatalogRows } from "../../scripts/emit-connector-catalog.mjs";

it("factoring reconstructs every provider field and does not replace differing or absent defaults", () => {
  const rows = [
    {
      id: "one",
      configured: false,
      callback_url: null,
      scopes: [],
      supports_refresh: true,
    },
    {
      id: "two",
      configured: false,
      callback_url: null,
      scopes: [],
      supports_refresh: false,
    },
    {
      id: "three",
      configured: false,
      callback_url: null,
      scopes: [],
      secret: "public-placeholder",
    },
  ];
  const factored = factorCatalogRows(rows);
  expect(factored.common).toEqual({
    configured: false,
    callback_url: null,
    scopes: [],
  });
  const restored = factored.rows.map((row) =>
    JSON.parse(JSON.stringify({ ...factored.common, ...row })),
  );
  expect(restored).toEqual(rows);
  expect(restored[2]).not.toHaveProperty("supports_refresh");
});
it("empty catalogs retain no defaults or invented rows", () => {
  expect(factorCatalogRows([])).toEqual({ common: {}, rows: [] });
});
