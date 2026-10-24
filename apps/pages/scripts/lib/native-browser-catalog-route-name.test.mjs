/** @vitest-environment node */
import { expect, it } from "vitest";
import { catalogProvider } from "../../../../packages/app-core/src/lib/connector-catalog.ts";
import { API_FAMILIES } from "../../src/sections/connections/catalog-families.ts";
import { nativeAuthFieldViolations } from "./native-browser-auth-field-contract.mjs";
import { nativeCatalogRouteRow } from "./native-browser-catalog-journey.mjs";
import {
  NATIVE_CANONICAL_PROVIDERS,
  nativeAuthFieldMethods,
  nativeCanonicalRouteProvider,
} from "./native-browser-catalog-projection.mjs";

const families = API_FAMILIES.flatMap((family) => {
  const provider = nativeCanonicalRouteProvider(family.id);
  return provider ? [{ family, provider }] : [];
});

it("resolves the actual AWS family route through its bundled Secrets Manager alias", () => {
  const family = API_FAMILIES.find((entry) => entry.id === "aws");
  const provider = nativeCanonicalRouteProvider("aws");
  expect(NATIVE_CANONICAL_PROVIDERS.some((entry) => entry.id === "aws")).toBe(
    false,
  );
  expect(provider).toEqual({
    id: "aws-secrets-manager",
    name: catalogProvider("aws")?.displayName,
  });
  expect(provider?.name).toBe("AWS Secrets Manager");
  expect(provider?.name).not.toBe(family?.name);
  expect(families.map(({ family }) => family.id)).toContain("aws");
  const methods = nativeAuthFieldMethods(provider.id);
  expect(nativeAuthFieldMethods("aws")).toEqual(methods);
  expect(methods).toMatchObject([
    {
      id: "api-key",
      fields: expect.arrayContaining([
        expect.objectContaining({
          id: "region",
          secret: false,
          required: true,
        }),
        expect.objectContaining({
          id: "access_key_id",
          secret: false,
          required: true,
        }),
        expect.objectContaining({
          id: "secret_access_key",
          secret: true,
          required: true,
        }),
      ]),
    },
  ]);
  const unexpected = [
    { label: "Token endpoint", type: "url", readOnly: false },
    { label: "Client secret", type: "password", readOnly: false },
  ];
  expect(
    nativeAuthFieldViolations(methods, {
      methodChoiceCount: 1,
      methodLabel: methods[0].label,
      selections: {},
      inputs: unexpected,
    }),
  ).toEqual(unexpected);
});

it.each(families)(
  "resolves $family.id by the production route identity",
  ({ family, provider }) => {
    const row = {
      id: family.id,
      name: family.name,
      href: `/connections/${encodeURIComponent(family.id)}`,
      capability: null,
    };
    expect(nativeCatalogRouteRow(row)).toEqual({
      ...row,
      id: provider.id,
      name: provider.name,
      catalogId: family.id,
    });
    expect(row.name).toBe(family.name);
    expect(row.id).toBe(family.id);
  },
);

it("preserves an unprojected tile without inventing another provider", () => {
  const row = { id: "unprojected-fixture-only", name: "Unprojected fixture" };
  expect(nativeCanonicalRouteProvider(row.id)).toBeNull();
  expect(nativeCatalogRouteRow(row)).toBe(row);
});
