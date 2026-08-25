/** @vitest-environment jsdom */
/**
 * Failure copy: every mapped code reads as plain words, unmapped upstream
 * codes keep their own description, and non-errors still say something.
 */

import { describe, expect, it } from "vitest";
import { describeFederationError } from "./federation-copy.js";
import { FederationError } from "./federation.js";

describe("describeFederationError", () => {
  it("maps access_denied to actionable words with the no-change anchor", () => {
    const text = describeFederationError(
      new FederationError("access_denied", "The broker refused: access_denied."),
    );
    expect(text).toContain("Access was denied");
    expect(text).toContain("Nothing was changed");
  });

  it("maps no_identity_api to the deployment explanation", () => {
    const text = describeFederationError(
      new FederationError("no_identity_api", "raw"),
    );
    expect(text).toContain("isn't connected to an identity service");
  });

  it("keeps an unmapped code's own message, anchored", () => {
    const text = describeFederationError(
      new FederationError(
        "temporarily_unavailable",
        "The broker refused: temporarily_unavailable.",
      ),
    );
    expect(text).toContain("temporarily_unavailable");
    expect(text).toContain("Nothing was changed");
  });

  it("passes a plain Error's message through", () => {
    expect(describeFederationError(new Error("boom"))).toBe("boom");
  });

  it("answers generic words for a non-Error", () => {
    expect(describeFederationError("nope")).toContain("Sign-in failed");
  });
});
