// @vitest-environment jsdom
/**
 * Taking an interaction link out of Pages' address. Ports mobile-MFA's link
 * hygiene (`App.linkhygiene.test.tsx`) onto the page port, and pins what
 * Pages must not do: read any address but `/i/<ref>` as a link.
 */
import { afterEach, describe, expect, it } from "vitest";
import { captureInteractionLink } from "./interactions.js";

const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";

afterEach(() => history.replaceState(null, "", "/"));

describe("interaction arrival", () => {
  it("reads the reference and leaves a clean address alone", () => {
    history.replaceState(null, "", `/i/${REF}`);
    expect(captureInteractionLink()).toEqual({ kind: "interaction", ref: REF });
    expect(window.location.pathname).toBe(`/i/${REF}`);
  });

  it("reads it under the deployment's base path", () => {
    history.replaceState(null, "", `/OpenSesame/i/${REF}`);
    expect(captureInteractionLink()).toEqual({ kind: "interaction", ref: REF });
  });

  it("scrubs the fragment before anything else, keeping the reference", () => {
    history.replaceState(null, "", `/i/${REF}#state=abc`);
    expect(captureInteractionLink()).toEqual({ kind: "interaction", ref: REF });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe(`/i/${REF}`);
  });

  it("refuses a link whose fragment carried a bearer, and scrubs it", () => {
    history.replaceState(null, "", `/i/${REF}#token=leaked`);
    expect(captureInteractionLink()).toEqual({ kind: "refused" });
    expect(window.location.hash).toBe("");
  });

  it("refuses credential material in the query, and takes the query out", () => {
    history.replaceState(null, "", `/i/${REF}?access_token=leaked`);
    expect(captureInteractionLink()).toEqual({ kind: "refused" });
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("leaked");
  });

  it("takes a legacy user code and its claim id out once read", () => {
    history.replaceState(
      null,
      "",
      `/i/${REF}?user_code=abcd-efgh&claim_id=clm_9&x=1`,
    );
    expect(captureInteractionLink()).toEqual({
      kind: "legacy",
      userCode: "ABCD-EFGH",
      claimId: "clm_9",
    });
    expect(window.location.search).toBe("?x=1");
  });

  it("leaves every other address alone, a sign-in callback above all", () => {
    for (const address of [
      "/?code=abc&state=xyz",
      "/?user_code=ABCD-EFGH",
      "/claim#token=osc_clm_a.b",
      "/i/",
    ]) {
      history.replaceState(null, "", address);
      expect(captureInteractionLink()).toEqual({ kind: "none" });
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(
        address,
      );
    }
  });
});
