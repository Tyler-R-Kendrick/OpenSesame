import { describe, expect, it } from "vitest";
import {
  MAX_INDEXED_TYPES,
  parseMarketplaceIndex,
} from "./marketplace-index.js";

const PIN = "a".repeat(64);

function index(overrides: Record<string, unknown> = {}, spec?: unknown) {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "Marketplace",
    metadata: { name: "Types" },
    spec: spec ?? { itemTypes: [{ path: "types/vehicle.json", sha256: PIN }] },
    ...overrides,
  });
}

describe("parseMarketplaceIndex", () => {
  it("reads names and pinned paths", () => {
    expect(parseMarketplaceIndex(index())).toEqual({
      ok: true,
      index: {
        name: "Types",
        description: "",
        itemTypes: [{ path: "types/vehicle.json", sha256: PIN }],
      },
    });
  });

  it("tolerates what else a marketplace lists beside item types", () => {
    const parsed = parseMarketplaceIndex(
      index({}, { itemTypes: [], connectors: [{ path: "c.json" }] }),
    );
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["an unknown envelope key", index({ extra: 1 })],
    ["another kind", index({ kind: "VaultItemType" })],
    ["another apiVersion", index({ apiVersion: "v2" })],
    ["a nameless marketplace", index({ metadata: {} })],
    [
      "an unknown metadata key",
      index({ metadata: { name: "x", url: "https://e" } }),
    ],
    [
      "an absolute URL",
      index({}, { itemTypes: [{ path: "https://evil.example/a.json" }] }),
    ],
    ["a parent segment", index({}, { itemTypes: [{ path: "../a.json" }] })],
    ["a leading slash", index({}, { itemTypes: [{ path: "/a.json" }] })],
    ["a non-JSON path", index({}, { itemTypes: [{ path: "a.js" }] })],
    [
      "an unknown entry key",
      index({}, { itemTypes: [{ path: "a.json", url: "x" }] }),
    ],
    [
      "an uppercase pin",
      index({}, { itemTypes: [{ path: "a.json", sha256: PIN.toUpperCase() }] }),
    ],
    [
      "a path listed twice",
      index({}, { itemTypes: [{ path: "a.json" }, { path: "a.json" }] }),
    ],
    [
      "too many entries",
      index(
        {},
        {
          itemTypes: Array.from({ length: MAX_INDEXED_TYPES + 1 }, (_, at) => ({
            path: `t${at}.json`,
          })),
        },
      ),
    ],
    ["not JSON", "{"],
    ["an oversized index", " ".repeat(70_000)],
  ])("refuses %s", (_name, text) => {
    expect(parseMarketplaceIndex(text).ok).toBe(false);
  });
});
