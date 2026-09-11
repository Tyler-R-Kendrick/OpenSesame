/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  LAST_SIGN_IN_KEY,
  canonicalSignInMethod,
  isLastSignInMethod,
  promoteLastSignIn,
  readLastSignIn,
  rememberLastSignIn,
} from "./last-sign-in.js";

afterEach(() => {
  localStorage.removeItem(LAST_SIGN_IN_KEY);
});

describe("canonicalSignInMethod", () => {
  it("treats Shoo as Google, the 3P the button actually is", () => {
    expect(canonicalSignInMethod("shoo")).toBe("google");
    expect(canonicalSignInMethod("Google")).toBe("google");
  });

  it("unwraps a brokered catalog id so GitHub stays GitHub", () => {
    expect(canonicalSignInMethod("broker:github")).toBe("github");
    expect(canonicalSignInMethod("broker:byo:https://idp.example")).toBe("byo");
  });
});

describe("rememberLastSignIn", () => {
  it("persists the canonical id and survives a later read", () => {
    rememberLastSignIn("broker:github");
    expect(localStorage.getItem(LAST_SIGN_IN_KEY)).toBe("github");
    expect(readLastSignIn()).toBe("github");
  });

  it("ignores an empty id rather than clearing a real last method", () => {
    rememberLastSignIn("google");
    rememberLastSignIn("   ");
    expect(readLastSignIn()).toBe("google");
  });
});

describe("isLastSignInMethod", () => {
  it("matches Shoo against the Google mark", () => {
    expect(isLastSignInMethod("shoo", "google")).toBe(true);
    expect(isLastSignInMethod("github", "google")).toBe(false);
    expect(isLastSignInMethod("google", null)).toBe(false);
  });
});

describe("promoteLastSignIn", () => {
  it("moves the last-used method to the front and leaves order otherwise", () => {
    const ids = ["google", "github", "apple"];
    expect(promoteLastSignIn(ids, "github", (id) => id)).toEqual([
      "github",
      "google",
      "apple",
    ]);
    expect(promoteLastSignIn(ids, null, (id) => id)).toEqual(ids);
    expect(promoteLastSignIn(ids, "google", (id) => id)).toEqual(ids);
  });
});
