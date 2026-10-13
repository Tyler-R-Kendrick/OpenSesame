import { describe, expect, it } from "vitest";
import { RELAY_MESSAGE, relayedMessage } from "./relay-wire.js";

describe("relayedMessage", () => {
  it("returns the page's message, whole", () => {
    expect(relayedMessage({ type: RELAY_MESSAGE, message: { a: 1 } })).toEqual({
      a: 1,
    });
  });
  it("is null for anything else", () => {
    for (const value of [
      null,
      "x",
      [],
      { type: "other", message: {} },
      { type: RELAY_MESSAGE },
    ])
      expect(relayedMessage(value)).toBeNull();
  });
});
