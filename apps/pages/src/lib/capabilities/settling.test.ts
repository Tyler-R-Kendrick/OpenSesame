import { describe, expect, it } from "vitest";
import { planIsSettling } from "./settling.js";

const snapshot = (
  approved: string[],
  lifecycle: Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: the ids are the fixture's own
) => ({ plan: { approvedCapabilities: approved }, lifecycle }) as any;

describe("planIsSettling", () => {
  it("holds the door while an approved capability is still on its way", () => {
    // The browser-local consent popup opens straight at
    // /identity/authorize, whose route `identity.local-iam` registers when
    // its module activates. Deciding before that redirected the popup to
    // the vault and ended the sign-in it was opened to complete.
    for (const state of ["approved-not-loaded", "loading"]) {
      expect(
        planIsSettling(
          snapshot(["identity.local-iam"], { "identity.local-iam": state }),
        ),
      ).toBe(true);
    }
  });

  it("lets a settled plan decide, including one that failed to load", () => {
    for (const state of [
      "active",
      "disabled",
      "disabled-restart-required",
      "revocation-pending",
      "cached-offline",
    ]) {
      expect(
        planIsSettling(
          snapshot(["identity.local-iam"], { "identity.local-iam": state }),
        ),
      ).toBe(false);
    }
  });

  it("ignores a lifecycle for a capability this plan did not approve", () => {
    expect(
      planIsSettling(
        snapshot(["identity.local-iam"], {
          "identity.local-iam": "active",
          "wallet.spending": "loading",
        }),
      ),
    ).toBe(false);
  });

  it("is false with no plan and with nothing approved", () => {
    expect(planIsSettling({ plan: null, lifecycle: {} })).toBe(false);
    expect(planIsSettling(snapshot([], { "wallet.spending": "loading" }))).toBe(
      false,
    );
  });
});
