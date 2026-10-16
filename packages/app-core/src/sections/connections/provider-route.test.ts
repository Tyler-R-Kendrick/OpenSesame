import { expect, it } from "vitest";
import { catalogProvider } from "../../lib/connector-catalog.js";
import {
  connectionRouteMatches,
  connectionRouteProvider,
} from "./provider-route.js";

function provider(id: string) {
  const row = catalogProvider(id);
  if (!row) throw new Error("Missing catalog fixture");
  return { ...row, id };
}

it("resolves the canonical secret backend deep link to the actual bundled alias without rewriting its id", () => {
  const alias = provider("bitwarden-secrets-manager");
  expect(connectionRouteProvider([alias], "bitwarden-sm")).toBe(alias);
  expect(alias.id).toBe("bitwarden-secrets-manager");
  expect(connectionRouteProvider([alias], alias.id)).toBe(alias);
});

it("prefers an exact provider id when canonical and alias rows both exist", () => {
  const canonical = provider("bitwarden-sm");
  const alias = provider("bitwarden-secrets-manager");
  expect(connectionRouteProvider([alias, canonical], "bitwarden-sm")).toBe(
    canonical,
  );
  expect(connectionRouteProvider([canonical, alias], alias.id)).toBe(alias);
});

it("includes saved records under either spelling without matching unrelated or unknown providers", () => {
  expect(
    connectionRouteMatches("bitwarden-secrets-manager", "bitwarden-sm"),
  ).toBe(true);
  expect(
    connectionRouteMatches("bitwarden-sm", "bitwarden-secrets-manager"),
  ).toBe(true);
  expect(connectionRouteMatches("bitwarden", "bitwarden-sm")).toBe(false);
  expect(connectionRouteMatches("custom", "custom")).toBe(true);
  expect(connectionRouteMatches("custom", "missing")).toBe(false);
  expect(connectionRouteMatches("custom", undefined)).toBe(false);
});

it("does not guess a provider before the catalog loads or for an unknown route", () => {
  const alias = provider("bitwarden-secrets-manager");
  expect(connectionRouteProvider(null, "bitwarden-sm")).toBeNull();
  expect(connectionRouteProvider([alias], undefined)).toBeNull();
  expect(connectionRouteProvider([alias], "unknown-provider")).toBeNull();
});
