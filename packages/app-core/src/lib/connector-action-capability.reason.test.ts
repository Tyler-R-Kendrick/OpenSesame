import { describe, expect, it } from "vitest";
import { connectorCardAction } from "./connector-action-capability.js";

const context = (
  overrides: Parameters<typeof connectorCardAction>[1] extends infer C
    ? Partial<C>
    : never = {},
) => ({
  routes: [],
  now: 1,
  ...overrides,
});

describe("why a card is unavailable", () => {
  it("names why a card is unavailable only when its owner can say, and calls a companion a desktop app only then", () => {
    expect(
      connectorCardAction(
        { id: "datadog" },
        context({ unavailableKind: "refuses-browser" }),
      ),
    ).toEqual({
      kind: "unavailable",
      glyph: "blocked",
      reason: "refuses-browser",
    });
    expect(
      connectorCardAction(
        { id: "keychain" },
        context({ nativeRequired: true, unavailableKind: "companion" }),
      ),
    ).toEqual({ kind: "native", glyph: "computer", reason: "companion" });
  });
});
