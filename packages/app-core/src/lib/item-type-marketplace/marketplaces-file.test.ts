import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKETPLACES_FILE,
  MAX_MARKETPLACES,
  encodeMarketplacesFile,
  isDefaultMarketplace,
  parseMarketplacesFile,
  withDefaultMarketplace,
  withMarketplace,
  withoutMarketplace,
} from "./marketplaces-file.js";
import { DEFAULT_MARKETPLACE } from "./source.js";

describe("marketplaces.json", () => {
  it("reads as ours alone when nobody has written it", () => {
    expect(parseMarketplacesFile(DEFAULT_MARKETPLACES_FILE)).toEqual({
      ok: true,
      sources: [DEFAULT_MARKETPLACE],
    });
    expect(isDefaultMarketplace(DEFAULT_MARKETPLACE)).toBe(true);
  });

  it("canonicalizes what a person wrote by hand", () => {
    const text = '{ "marketplaces": ["https://gitlab.com/team/types.git"] }';
    expect(parseMarketplacesFile(text)).toEqual({
      ok: true,
      sources: ["gitlab:team/types"],
    });
  });

  it.each([
    ["not JSON", "{"],
    ["another key", '{"marketplaces":[],"token":"x"}'],
    ["a non-list", '{"marketplaces":"octo/types"}'],
    ["an unreadable entry", '{"marketplaces":["http://example.com/x/y"]}'],
    ["a repeat", '{"marketplaces":["octo/types","github:octo/types"]}'],
    [
      "too many",
      encodeMarketplacesFile(
        Array.from({ length: MAX_MARKETPLACES + 1 }, (_, at) => `octo/t${at}`),
      ),
    ],
  ])("refuses %s", (_name, text) => {
    expect(parseMarketplacesFile(text).ok).toBe(false);
  });

  it("adds, refuses a second spelling, removes, and puts ours back first", () => {
    const added = withMarketplace(DEFAULT_MARKETPLACES_FILE, "octo/types");
    if (!added.ok) throw new Error(added.message);
    expect(added.reference).toBe("github:octo/types");
    expect(
      withMarketplace(added.text, "https://github.com/octo/types").ok,
    ).toBe(false);
    expect(withMarketplace(added.text, "not a repo").ok).toBe(false);
    const removed = withoutMarketplace(added.text, DEFAULT_MARKETPLACE);
    if (!removed.ok) throw new Error(removed.message);
    expect(parseMarketplacesFile(removed.text)).toEqual({
      ok: true,
      sources: ["github:octo/types"],
    });
    const restored = withDefaultMarketplace(removed.text);
    expect(restored.ok && parseMarketplacesFile(restored.text)).toEqual({
      ok: true,
      sources: [DEFAULT_MARKETPLACE, "github:octo/types"],
    });
  });
});
