import { describe, expect, it } from "vitest";
import { ModelKeyRefusal } from "./errors.js";
import { describeMintFailure } from "./mint-failure.js";

describe("saying why a key was not created", () => {
  it("turns the reasons a person can cause into the step that fixes them", () => {
    expect(
      describeMintFailure(
        new ModelKeyRefusal("invalid_target", "draft.connection"),
      ),
    ).toBe("Verify this provider's key before creating one.");
    expect(
      describeMintFailure(
        new ModelKeyRefusal("access_denied", "broker.unavailable"),
      ),
    ).toBe("Turn on External connectors to create keys.");
  });

  it("says nothing about the broker's internals for a reason it does not know", () => {
    const said = describeMintFailure(
      new ModelKeyRefusal("access_denied", "ledger.full.internal-detail"),
    );
    expect(said).toBe("The key could not be created.");
    expect(said).not.toContain("ledger");
  });

  it("keeps the vault's own sentence, and never prints a thrown value that is not an error", () => {
    expect(
      describeMintFailure(new Error("Only an operator can do that.")),
    ).toBe("Only an operator can do that.");
    expect(describeMintFailure("osk_leak")).toBe(
      "The key could not be created.",
    );
    expect(describeMintFailure(null)).toBe("The key could not be created.");
    expect(describeMintFailure(new Error(""))).toBe(
      "The key could not be created.",
    );
  });

  it("does not echo an approval refusal's detail", () => {
    expect(
      describeMintFailure(
        new ModelKeyRefusal("access_denied", "approval.stale"),
      ),
    ).toBe("The approval was not accepted.");
  });
});
