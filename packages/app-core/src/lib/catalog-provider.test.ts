import { expect, it } from "vitest";
import { byoProvidersFirst } from "./catalog-provider.js";
import { getBundledProviders } from "./embedded-catalog.js";

const byId = new Map(
  getBundledProviders().map((provider) => [provider.id, provider]),
);

function pick(ids: readonly string[]) {
  return ids.map((id) => {
    const provider = byId.get(id);
    if (!provider) throw new Error(`Missing bundled provider: ${id}`);
    return provider;
  });
}

it("puts BYO providers first while preserving partner order and the input", () => {
  const input = pick([
    "openai",
    "byo-identity",
    "anthropic",
    "byo-ai",
    "supabase",
  ]);
  const original = [...input];
  const ordered = byoProvidersFirst(input);
  expect(ordered.map((provider) => provider.id)).toEqual([
    "byo-identity",
    "byo-ai",
    "openai",
    "anthropic",
    "supabase",
  ]);
  expect(input).toEqual(original);
});

it("leaves a list without BYO providers in its original order", () => {
  const input = pick(["openai", "anthropic", "supabase"]);
  expect(byoProvidersFirst(input)).toEqual(input);
  expect(byoProvidersFirst([])).toEqual([]);
});
