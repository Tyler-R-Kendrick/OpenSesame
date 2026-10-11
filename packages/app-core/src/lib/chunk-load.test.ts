import { describe, expect, it } from "vitest";
import { STALE_BUILD, isChunkLoadFailure } from "./chunk-load.js";

describe("a lazy chunk that cannot be fetched", () => {
  it.each([
    [
      "Chrome",
      new TypeError(
        "Failed to fetch dynamically imported module: https://example.test/OpenSesame/assets/device-identity-carry-Bvwzak28.js",
      ),
    ],
    [
      "Firefox",
      new TypeError(
        "error loading dynamically imported module: https://example.test/assets/x.js",
      ),
    ],
    ["Safari", new TypeError("Importing a module script failed.")],
    ["a bundler chunk", new Error("Loading chunk 42 failed.")],
    ["a bundler stylesheet", new Error("Loading CSS chunk 7 failed.")],
  ])("is recognised as %s words it", (_browser, caught) => {
    expect(isChunkLoadFailure(caught)).toBe(true);
  });

  it("is not any other failure", () => {
    expect(isChunkLoadFailure(new Error("Wrong PIN"))).toBe(false);
    expect(isChunkLoadFailure(new Error(""))).toBe(false);
    expect(
      isChunkLoadFailure("Failed to fetch dynamically imported module"),
    ).toBe(false);
    expect(isChunkLoadFailure(null)).toBe(false);
  });

  it("is told as the page being out of date, with the remedy", () => {
    expect(STALE_BUILD).toMatch(/out of date/);
    expect(STALE_BUILD).toMatch(/Reload/);
    expect(STALE_BUILD).not.toMatch(/https?:/);
  });
});
