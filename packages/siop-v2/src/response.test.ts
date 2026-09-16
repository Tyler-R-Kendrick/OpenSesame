import { describe, expect, it } from "vitest";
import { isSiopV2Error } from "./errors.js";
import { MAX_FRAGMENT_RESPONSE_CHARS, MAX_ID_TOKEN_CHARS } from "./limits.js";
import {
  attachFragment,
  parseFragmentResponse,
  serializeFragmentError,
  serializeFragmentSuccess,
} from "./response.js";

function expectCode(run: () => void, code: string, checkpoint: string): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (err) {
    expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
    if (err instanceof Error && isSiopV2Error(err)) {
      expect(err.code).toBe(code);
      expect(err.checkpoint).toBe(checkpoint);
    }
  }
}

describe("serializeFragmentSuccess", () => {
  it("serializes id_token and optional state", () => {
    expect(serializeFragmentSuccess({ idToken: "abc", state: "s1" })).toBe(
      "id_token=abc&state=s1",
    );
    expect(serializeFragmentSuccess({ idToken: "abc", state: null })).toBe(
      "id_token=abc",
    );
  });

  it("refuses empty or oversized id_token", () => {
    expectCode(
      () => serializeFragmentSuccess({ idToken: "", state: null }),
      "limit_exceeded",
      "limits",
    );
    expectCode(
      () =>
        serializeFragmentSuccess({
          idToken: "x".repeat(MAX_ID_TOKEN_CHARS + 1),
          state: null,
        }),
      "limit_exceeded",
      "limits",
    );
  });
});

describe("serializeFragmentError", () => {
  it("serializes error, description, and state", () => {
    expect(
      serializeFragmentError({
        error: "access_denied",
        errorDescription: "nope",
        state: "s1",
      }),
    ).toBe("error=access_denied&error_description=nope&state=s1");
    expect(
      serializeFragmentError({
        error: "access_denied",
        errorDescription: null,
        state: null,
      }),
    ).toBe("error=access_denied");
  });

  it("refuses an empty error code", () => {
    expectCode(
      () =>
        serializeFragmentError({
          error: "",
          errorDescription: null,
          state: null,
        }),
      "malformed_request",
      "response_serialize",
    );
  });
});

describe("attachFragment", () => {
  it("attaches a hash, replacing any prior fragment", () => {
    expect(attachFragment("https://rp.example/cb", "id_token=a")).toBe(
      "https://rp.example/cb#id_token=a",
    );
    expect(attachFragment("https://rp.example/cb#old", "#id_token=a")).toBe(
      "https://rp.example/cb#id_token=a",
    );
  });

  it("refuses an empty redirect URI", () => {
    expectCode(
      () => attachFragment("", "id_token=a"),
      "malformed_request",
      "response_serialize",
    );
  });
});

describe("parseFragmentResponse", () => {
  it("parses success and error fragments from bare and absolute URLs", () => {
    expect(parseFragmentResponse("id_token=tok&state=s1")).toEqual({
      kind: "success",
      idToken: "tok",
      state: "s1",
    });
    expect(
      parseFragmentResponse("https://rp.example/cb#error=access_denied"),
    ).toEqual({
      kind: "error",
      error: "access_denied",
      errorDescription: null,
      state: null,
    });
    expect(
      parseFragmentResponse(
        "https://rp.example/cb#error=access_denied&error_description=nope&state=s",
      ),
    ).toEqual({
      kind: "error",
      error: "access_denied",
      errorDescription: "nope",
      state: "s",
    });
  });

  it("accepts openid: URLs and hash-prefixed fragments", () => {
    expect(parseFragmentResponse("openid://cb#id_token=tok")).toEqual({
      kind: "success",
      idToken: "tok",
      state: null,
    });
    expect(parseFragmentResponse("#id_token=tok")).toEqual({
      kind: "success",
      idToken: "tok",
      state: null,
    });
  });

  it("treats empty state as null", () => {
    expect(parseFragmentResponse("id_token=tok&state=")).toEqual({
      kind: "success",
      idToken: "tok",
      state: null,
    });
  });

  it("refuses success+error together, duplicates, and empty bodies", () => {
    expectCode(
      () => parseFragmentResponse("id_token=tok&error=access_denied"),
      "malformed_request",
      "response_parse",
    );
    expectCode(
      () => parseFragmentResponse("id_token=a&id_token=b"),
      "malformed_request",
      "response_parse",
    );
    expectCode(
      () => parseFragmentResponse("error=a&error=b"),
      "malformed_request",
      "response_parse",
    );
    expectCode(
      () => parseFragmentResponse(""),
      "malformed_request",
      "response_parse",
    );
    expectCode(
      () => parseFragmentResponse("?id_token=tok"),
      "malformed_request",
      "response_parse",
    );
  });

  it("refuses malformed absolute URLs and oversized input", () => {
    expectCode(
      () => parseFragmentResponse("https://[::not-a-url"),
      "malformed_request",
      "response_parse",
    );
    expectCode(
      () =>
        parseFragmentResponse("x".repeat(MAX_FRAGMENT_RESPONSE_CHARS + 2049)),
      "limit_exceeded",
      "limits",
    );
    expectCode(
      () =>
        parseFragmentResponse(`id_token=${"x".repeat(MAX_ID_TOKEN_CHARS + 1)}`),
      "limit_exceeded",
      "limits",
    );
  });
});
