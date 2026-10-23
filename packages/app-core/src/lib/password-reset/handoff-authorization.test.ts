import { afterEach, describe, expect, it } from "vitest";
import {
  RESET_AUTHORIZATION_TTL_MS,
  authorizeResetHandoff,
  consumeResetHandoffAuthorization,
  resetResetHandoffAuthorizationsForTest,
} from "./handoff-authorization.js";

const REQUEST = {
  itemId: "item-1",
  origin: "https://example.com",
  messageId: "m1",
};

afterEach(() => {
  resetResetHandoffAuthorizationsForTest();
});

describe("password-reset hand-off authorization", () => {
  it("never authorizes a message without a person's outstanding request", () => {
    expect(consumeResetHandoffAuthorization(REQUEST, 1_000)).toBeNull();
  });

  it("consumes the user-created nonce once and only for its exact match", () => {
    const nonce = authorizeResetHandoff(REQUEST, 1_000);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(
      consumeResetHandoffAuthorization(
        { ...REQUEST, messageId: "another" },
        1_001,
      ),
    ).toBeNull();
    expect(consumeResetHandoffAuthorization(REQUEST, 1_001)).toBe(nonce);
    expect(consumeResetHandoffAuthorization(REQUEST, 1_002)).toBeNull();
  });

  it("expires an approval that the person did not act on", () => {
    authorizeResetHandoff(REQUEST, 1_000);
    expect(
      consumeResetHandoffAuthorization(
        REQUEST,
        1_000 + RESET_AUTHORIZATION_TTL_MS,
      ),
    ).toBeNull();
  });
});
