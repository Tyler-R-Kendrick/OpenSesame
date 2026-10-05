import { describe, expect, it } from "vitest";
import { unlockRoute } from "./use-unlock-gate.js";

/**
 * Which gate the unlock form is, for the help key it draws (ADR 0166). The
 * route decides which tutorials are offered, so each screen of the form must
 * name the one whose controls it draws.
 */
describe("the unlock form's route", () => {
  it("is the sign-in stage on first run's provider panel", () => {
    expect(unlockRoute(true, false, "")).toBe("/unlock/signin");
    expect(unlockRoute(true, false, "password")).toBe("/unlock/signin");
  });

  it("is the typed key ceremony for a password, a PIN, a recovery key or an age key", () => {
    for (const method of ["password", "pin", "recovery", "age"]) {
      expect(unlockRoute(false, false, method), method).toBe("/unlock/form");
    }
  });

  it("is the passkey ceremony when the passkey tab is the one picked", () => {
    expect(unlockRoute(false, false, "passkey")).toBe("/unlock/passkey");
  });

  it("offers no tour where the key ceremony is not the screen", () => {
    // The second step, a duress code and a vault with no key draw no method.
    expect(unlockRoute(false, false, "")).toBe("/unlock");
    // A passkey that opens an age key has no tab a tutorial points at.
    expect(unlockRoute(false, false, "agePasskey")).toBe("/unlock");
    // The user menu's Sign in on a returning vault is the provider panel.
    expect(unlockRoute(false, true, "password")).toBe("/unlock");
  });
});
