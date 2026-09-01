/** @vitest-environment jsdom */
/**
 * The sign-in outcome record: survives one navigation, never resurrects
 * garbage, and clears cleanly.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearAuthOutcome,
  readAuthOutcome,
  storeAuthOutcome,
} from "./auth-outcome.js";

const OUTCOME_KEY = "opensesame:federation:outcome";

afterEach(() => {
  sessionStorage.clear();
});

describe("auth outcome store", () => {
  it("round-trips an outcome with detail and who", () => {
    storeAuthOutcome({
      kind: "link_failed",
      detail: "Identity unreachable.",
      who: "sam@acme.com",
    });

    expect(readAuthOutcome()).toEqual({
      kind: "link_failed",
      detail: "Identity unreachable.",
      who: "sam@acme.com",
    });
  });

  it("answers null when nothing was stored", () => {
    expect(readAuthOutcome()).toBeNull();
  });

  it("answers null for a stored record with an unknown kind", () => {
    sessionStorage.setItem(OUTCOME_KEY, JSON.stringify({ kind: "mystery" }));

    expect(readAuthOutcome()).toBeNull();
  });

  it("answers null for a stored record that is not JSON", () => {
    sessionStorage.setItem(OUTCOME_KEY, "{nope");

    expect(readAuthOutcome()).toBeNull();
  });

  it("clears the record", () => {
    storeAuthOutcome({ kind: "linked" });
    clearAuthOutcome();

    expect(readAuthOutcome()).toBeNull();
  });
});

describe("sign-out and attach outcomes", () => {
  it("round-trips a switching sign-out", () => {
    storeAuthOutcome({ kind: "signed_out", switching: true });
    expect(readAuthOutcome()).toEqual({ kind: "signed_out", switching: true });
  });

  it("knows which outcomes ask for the Sign in tab, and which force a login", async () => {
    const { outcomeForcesLogin, outcomeWantsSignIn } = await import(
      "./auth-outcome.js"
    );
    expect(outcomeWantsSignIn({ kind: "signed_out" })).toBe(true);
    expect(outcomeWantsSignIn({ kind: "attach" })).toBe(true);
    expect(outcomeWantsSignIn({ kind: "linked" })).toBe(false);
    expect(outcomeWantsSignIn(null)).toBe(false);
    expect(outcomeForcesLogin({ kind: "signed_out", switching: true })).toBe(
      true,
    );
    expect(outcomeForcesLogin({ kind: "signed_out" })).toBe(false);
    expect(outcomeForcesLogin({ kind: "attach" })).toBe(false);
  });
});
