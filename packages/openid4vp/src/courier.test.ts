/**
 * Reading a courier delivery, and refusing the ones this verifier cannot read.
 *
 * The security-bearing behaviour is the refusal: an encrypted response mode, or
 * a JWE smuggled under a cleartext mode, must fail closed as
 * `response_encryption_unsupported` rather than be read as if the sealed part
 * were not there. The passthrough is the boring half — a cleartext delivery
 * becomes the `PresentationResponse` the verifier re-validates.
 */

import { describe, expect, it } from "vitest";
import {
  ENCRYPTED_RESPONSE_MODES,
  isCompactJwe,
  isEncryptedResponseMode,
  readCourierResponse,
} from "./courier.js";
import { Openid4vpError } from "./errors.js";

function refusalCode(run: () => void): string | null {
  try {
    run();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) return thrown.code;
    throw thrown;
  }
  return null;
}

/** A five-segment string shaped like a compact JWE, without decoding anything. */
function fakeCompactJwe(): string {
  return ["eyJhbGciOiJFQ0RILUVTIn0", "", "aXY", "Y2lwaGVy", "dGFn"].join(".");
}

describe("readCourierResponse", () => {
  it("refuses an encrypted response mode by name (T-21)", () => {
    for (const responseMode of ENCRYPTED_RESPONSE_MODES) {
      expect(
        refusalCode(() =>
          readCourierResponse({
            responseMode,
            body: { vp_token: { pid: ["x"] }, state: "s" },
          }),
        ),
      ).toBe("response_encryption_unsupported");
      expect(isEncryptedResponseMode(responseMode)).toBe(true);
    }
    expect(isEncryptedResponseMode("direct_post")).toBe(false);
    expect(isEncryptedResponseMode("dc_api")).toBe(false);
  });

  it("refuses a JWE smuggled under a cleartext mode (T-21)", () => {
    // The downgrade this fails closed on: a cleartext mode on the outside, an
    // encrypted response on the inside, hoping the verifier reads the wrapper
    // and never the sealed part.
    expect(isCompactJwe(fakeCompactJwe())).toBe(true);
    expect(
      refusalCode(() =>
        readCourierResponse({
          responseMode: "direct_post",
          body: { response: fakeCompactJwe(), state: "s" },
        }),
      ),
    ).toBe("response_encryption_unsupported");
  });

  it("passes a cleartext direct_post delivery through (T-22)", () => {
    const response = readCourierResponse({
      responseMode: "direct_post",
      body: { vp_token: { pid: ["presentation"] }, state: "sess-1" },
    });
    expect(response).toEqual({
      state: "sess-1",
      responseMode: "direct_post",
      vpToken: { pid: ["presentation"] },
    });
  });

  it("takes the caller's state for a dc_api delivery that carries none (T-22)", () => {
    const response = readCourierResponse({
      responseMode: "dc_api",
      state: "held-by-the-session",
      body: { vp_token: { pid: ["presentation"] } },
    });
    expect(response.state).toBe("held-by-the-session");
    expect(response.responseMode).toBe("dc_api");
  });

  it("refuses a delivery with no vp_token and one with no state", () => {
    expect(
      refusalCode(() =>
        readCourierResponse({
          responseMode: "direct_post",
          body: { state: "s" },
        }),
      ),
    ).toBe("malformed_presentation");
    expect(
      refusalCode(() =>
        readCourierResponse({
          responseMode: "direct_post",
          body: { vp_token: { pid: ["x"] } },
        }),
      ),
    ).toBe("state_unknown");
  });

  it("does not mistake a compact JWS for a JWE", () => {
    // Three segments, not five: an ordinary signed token is not an encrypted one.
    expect(isCompactJwe("aaa.bbb.ccc")).toBe(false);
  });
});
