// @vitest-environment jsdom
/**
 * Taking a claim link out of the address. Ports the ceremonies app's "claim
 * ceremony drop branch" cases (`DropAcceptance.test.tsx`), its fragment-first
 * pact, and the console's "strips it from the address bar" case.
 */
import { afterEach, describe, expect, it } from "vitest";
import { captureClaimLink, readClaimArrival } from "./link.js";

afterEach(() => history.replaceState(null, "", "/"));

describe("claim arrival", () => {
  it("routes a link carrying token and key straight to the drop", () => {
    history.replaceState(
      null,
      "",
      "/claim#token=osc_clm_a.b&key=a2V5LW1hdGVyaWFs", // gitleaks:allow -- synthetic security test vector
    );
    expect(captureClaimLink()).toEqual({
      kind: "drop",
      token: "osc_clm_a.b",
      key: "a2V5LW1hdGVyaWFs",
    });
    // Fragment discipline: the bearer and key leave the URL immediately.
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/claim");
  });

  it("picks a claim token up from the fragment and strips it", () => {
    history.replaceState(null, "", "/claim?x=1#token=osc_clm_hash.secret");
    expect(captureClaimLink()).toEqual({
      kind: "claim",
      token: "osc_clm_hash.secret",
    });
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?x=1");
  });

  it("leaves a fragment with no bearer on the claim path, untouched", () => {
    history.replaceState(null, "", "/claim#other=1");
    expect(captureClaimLink()).toEqual({ kind: "none" });
    expect(window.location.hash).toBe("#other=1");
  });

  it("adversarial: a mangled bearer is still taken out of history", () => {
    history.replaceState(null, "", "/claim#token=garbage&key=k");
    expect(captureClaimLink()).toEqual({ kind: "none" });
    expect(window.location.hash).toBe("");
  });

  it("adversarial: a bearer in the query string is scrubbed and refused", () => {
    // It was already on a request line; presenting it now would spend a token
    // somebody else may hold.
    history.replaceState(null, "", "/claim?token=osc_clm_a.b&key=k&x=1");
    expect(captureClaimLink()).toEqual({ kind: "leaked" });
    expect(window.location.search).toBe("?x=1");
  });
});

describe("readClaimArrival", () => {
  it("changes nothing when nothing needs to leave the address", () => {
    expect(
      readClaimArrival({ pathname: "/claim", search: "?a=1", hash: "#b=2" }),
    ).toEqual({ arrival: { kind: "none" }, scrubbed: null });
  });

  it("keeps the rest of the address when a leaked bearer is removed", () => {
    expect(
      readClaimArrival({
        pathname: "/claim",
        search: "?token=osc_clm_a.b",
        hash: "#b=2",
      }),
    ).toEqual({ arrival: { kind: "leaked" }, scrubbed: "/claim#b=2" });
  });

  it("does not take an unrelated query token for a leaked claim", () => {
    expect(
      readClaimArrival({ pathname: "/", search: "?token=abc", hash: "" }),
    ).toEqual({ arrival: { kind: "none" }, scrubbed: null });
  });
});
