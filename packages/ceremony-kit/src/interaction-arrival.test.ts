/**
 * What an address opened an interaction surface on. Ports mobile-MFA's link
 * cases: `App.linkhygiene.test.tsx`, the three `App.deeplink*.test.tsx` files
 * and the link cases of `App.test.tsx`, against the pure reader.
 */
import { describe, expect, it } from "vitest";
import { readInteractionArrival } from "./interaction-arrival.js";

const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";

describe("canonical links", () => {
  it("reads the reference, and leaves a clean address alone", () => {
    expect(readInteractionArrival(`https://app.example/i/${REF}`)).toEqual({
      arrival: { kind: "interaction", ref: REF },
      scrubbed: null,
    });
  });

  it("reads it under a deployment's base path", () => {
    expect(
      readInteractionArrival(`https://me.github.io/OpenSesame/i/${REF}`)
        .arrival,
    ).toEqual({ kind: "interaction", ref: REF });
  });

  it("takes a fragment out, and the reference survives it", () => {
    expect(
      readInteractionArrival(`http://localhost/i/${REF}#state=abc`),
    ).toEqual({
      arrival: { kind: "interaction", ref: REF },
      scrubbed: `/i/${REF}`,
    });
  });

  it("refuses a link whose fragment carried a bearer, and scrubs it", () => {
    expect(
      readInteractionArrival(`https://app.example/i/${REF}#token=leaked`),
    ).toEqual({ arrival: { kind: "refused" }, scrubbed: `/i/${REF}` });
  });

  it("does not read a malformed reference or a plaintext remote link", () => {
    expect(
      readInteractionArrival("https://app.example/i/..%2Fadmin").arrival,
    ).toEqual({ kind: "none" });
    expect(
      readInteractionArrival(`http://app.example/i/${REF}`).arrival,
    ).toEqual({ kind: "none" });
  });
});

describe("forbidden parameters", () => {
  it("refuses ?token= rather than parsing around it, and drops the query", () => {
    const read = readInteractionArrival(
      "https://app.example/?token=leaked&user_code=ABCD-EFGH",
    );
    // The user code rode on the same link and is not offered as a fallback.
    expect(read).toEqual({ arrival: { kind: "refused" }, scrubbed: "/" });
  });

  it("names nothing in the refusal", () => {
    const read = readInteractionArrival("https://app.example/?access_token=x");
    expect(JSON.stringify(read)).not.toContain("access_token");
  });

  it("refuses a canonical path that carries credential material", () => {
    expect(
      readInteractionArrival(`https://app.example/i/${REF}?token=leaked`),
    ).toEqual({ arrival: { kind: "refused" }, scrubbed: `/i/${REF}` });
  });
});

describe("legacy links", () => {
  it("reads the user code through the kit's legacy parser, with the claim id", () => {
    expect(
      readInteractionArrival(
        "opensesame-mfa://approve?user_code=ABCD-EFGH&claim_id=clm_9",
      ).arrival,
    ).toEqual({ kind: "legacy", userCode: "ABCD-EFGH", claimId: "clm_9" });
  });

  it("accepts the ?code= alias and uppercases it, then scrubs both", () => {
    expect(
      readInteractionArrival(
        "http://localhost:3000/?code=wxyz-1234&claim_id=clm_2&x=1",
      ),
    ).toEqual({
      arrival: { kind: "legacy", userCode: "WXYZ-1234", claimId: "clm_2" },
      scrubbed: "/?x=1",
    });
  });

  it("uppercases a ?user_code= on a browser link", () => {
    expect(
      readInteractionArrival("https://app.example/?user_code=abcd-efgh")
        .arrival,
    ).toEqual({ kind: "legacy", userCode: "ABCD-EFGH" });
  });

  it("drops a claim id outside its alphabet rather than echoing it", () => {
    expect(
      readInteractionArrival(
        "https://app.example/?user_code=ABCD&claim_id=%3Cb%3Ehi",
      ).arrival,
    ).toEqual({ kind: "legacy", userCode: "ABCD" });
  });

  it("is not a link at all when the scheme carries no code", () => {
    expect(readInteractionArrival("opensesame-mfa://approve")).toEqual({
      arrival: { kind: "none" },
      scrubbed: null,
    });
    expect(readInteractionArrival("not a url").arrival).toEqual({
      kind: "none",
    });
  });
});
