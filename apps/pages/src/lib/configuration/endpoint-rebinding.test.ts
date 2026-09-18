import { describe, expect, it } from "vitest";
import { authorizationForDestination } from "./endpoint-rebinding.js";

describe("authorizationForDestination ADV-13", () => {
  it("does not forward an old Authorization header to a new API origin", () => {
    const stored = {
      destination: "https://id.example",
      authorization: "Bearer old",
    };
    expect(authorizationForDestination(stored, "https://id.example")).toBe(
      "Bearer old",
    );
    expect(
      authorizationForDestination(stored, "https://evil.example"),
    ).toBeNull();
  });
});
