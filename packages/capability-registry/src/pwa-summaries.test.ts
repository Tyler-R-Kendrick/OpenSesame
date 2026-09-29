import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./index.js";
import { pwaSummaries } from "./pwa-summaries.js";

describe("pwa-summaries.json (ADR 0139: one definition, every target)", () => {
  it("is exactly the page-reachable projection of CAPABILITIES", () => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL("../pwa-summaries.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(pwaSummaries(CAPABILITIES));
  });

  it("carries no surface map or exclusion beyond the page's own surface", () => {
    for (const summary of pwaSummaries(CAPABILITIES)) {
      expect(Object.keys(summary).sort()).toEqual([
        "id",
        "plane",
        "surfaces",
        "title",
      ]);
      expect(Object.keys(summary.surfaces)).toEqual(["pwa"]);
    }
  });

  it("drops every capability a page cannot reach", () => {
    const ids = new Set(pwaSummaries(CAPABILITIES).map((s) => s.id));
    for (const capability of CAPABILITIES) {
      expect(ids.has(capability.id)).toBe(capability.surfaces.pwa !== null);
    }
  });
});
