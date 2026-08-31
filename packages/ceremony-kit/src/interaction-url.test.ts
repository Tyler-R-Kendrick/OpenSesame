import { FORBIDDEN_URL_PARAMS } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  InteractionLinkError,
  assertNoForbiddenParams,
  buildInteractionUrl,
  isInteractionRef,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./index.js";

const REF = `i_${"a".repeat(24)}.${"b".repeat(32)}`;

/** `access_token` as a caller who prefers camelCase would spell it. */
function camel(name: string): string {
  return name.replace(/_(.)/g, (_match, next: string) => next.toUpperCase());
}

function reason(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof InteractionLinkError) return error.reason;
    return `unexpected:${String(error)}`;
  }
  return "no-throw";
}

describe("buildInteractionUrl", () => {
  it("puts the reference in the path and nothing anywhere else", () => {
    expect(buildInteractionUrl("https://ceremonies.example", REF)).toBe(
      `https://ceremonies.example/i/${REF}`,
    );
  });

  it("keeps a deployment path prefix and normalizes trailing slashes", () => {
    expect(buildInteractionUrl("https://x.test/OpenSesame/", REF)).toBe(
      `https://x.test/OpenSesame/i/${REF}`,
    );
    expect(buildInteractionUrl("https://x.test/", REF)).toBe(
      `https://x.test/i/${REF}`,
    );
  });

  it("allows plaintext only against a loopback literal", () => {
    for (const base of [
      "http://127.0.0.1:8788",
      "http://[::1]:8788",
      "http://localhost:5180",
    ]) {
      expect(buildInteractionUrl(base, REF)).toContain(`/i/${REF}`);
    }
  });

  it("rejects http on a host that is not loopback", () => {
    expect(
      reason(() => buildInteractionUrl("http://ceremonies.example", REF)),
    ).toBe("insecure_transport");
    // A private address still crosses a wire, so it gets no exception.
    expect(reason(() => buildInteractionUrl("http://192.168.1.10", REF))).toBe(
      "insecure_transport",
    );
    expect(reason(() => buildInteractionUrl("ftp://x.test", REF))).toBe(
      "insecure_transport",
    );
  });

  it("rejects userinfo", () => {
    expect(reason(() => buildInteractionUrl("https://u:p@x.test", REF))).toBe(
      "base_carries_userinfo",
    );
    expect(reason(() => buildInteractionUrl("https://u@x.test", REF))).toBe(
      "base_carries_userinfo",
    );
  });

  it("rejects a base that already carries a query or fragment", () => {
    expect(reason(() => buildInteractionUrl("https://x.test/?a=b", REF))).toBe(
      "base_carries_parameters",
    );
    expect(reason(() => buildInteractionUrl("https://x.test/#a=b", REF))).toBe(
      "base_carries_parameters",
    );
  });

  it("rejects a malformed base", () => {
    expect(reason(() => buildInteractionUrl("not a url", REF))).toBe(
      "malformed_base",
    );
    expect(reason(() => buildInteractionUrl("", REF))).toBe("malformed_base");
    expect(
      reason(() =>
        buildInteractionUrl(`https://x.test/${"p".repeat(4096)}`, REF),
      ),
    ).toBe("malformed_base");
  });

  it("rejects a reference that is not i_<base64url>.<tag> shaped", () => {
    for (const bad of [
      "",
      "i_bad",
      "i_aaaa.bbb",
      "../../admin",
      `i_${"a".repeat(24)}.${"b".repeat(32)}extra!`,
      `c_${"a".repeat(24)}.${"b".repeat(32)}`,
      `i_${"a".repeat(24)}.${"b".repeat(32)}?x=1`,
    ]) {
      expect(reason(() => buildInteractionUrl("https://x.test", bad))).toBe(
        "malformed_ref",
      );
    }
    expect(isInteractionRef(REF)).toBe(true);
    expect(isInteractionRef("i_aaaa.bbb")).toBe(false);
  });
});

describe("forbidden material", () => {
  it("has a non-empty deny list to work from", () => {
    // The check fails closed, so an empty list would silently pass everything.
    expect(FORBIDDEN_URL_PARAMS.length).toBeGreaterThan(0);
    expect(reason(() => assertNoForbiddenParams("https://x.test/"))).toBe(
      "no-throw",
    );
  });

  it.each([...FORBIDDEN_URL_PARAMS])(
    "refuses %s in query and fragment, snake_case and camelCase",
    (name) => {
      for (const spelling of [name, camel(name), name.toUpperCase()]) {
        for (const url of [
          `https://x.test/?${spelling}=v`,
          `https://x.test/#${spelling}=v`,
          `https://x.test/#/approve?${spelling}=v`,
        ]) {
          expect(reason(() => assertNoForbiddenParams(url))).toBe(
            "forbidden_parameter",
          );
          expect(reason(() => buildInteractionUrl(url, REF))).toBe(
            "forbidden_parameter",
          );
        }
      }
    },
  );

  it("finds a name past a separator inside an earlier value", () => {
    // `URLSearchParams` reads a section as one flat key/value list, so it
    // stops finding names the moment a separator appears inside a value:
    // `#/approve?b=1#token=leak` parses as a single pair named `b`. Routers
    // write exactly that shape, and the token in it is every bit as readable
    // to whoever holds the URL.
    for (const url of [
      "https://x.test/i/r#/approve?b=1#token=leak",
      "https://x.test/i/r#/a?b=1&c=2#access_token=leak",
      "https://x.test/i/r?a=1;refresh_token=leak",
      "https://x.test/i/r#/step/2?ok=1#claim_token=leak",
    ]) {
      expect(reason(() => assertNoForbiddenParams(url))).toBe(
        "forbidden_parameter",
      );
    }
  });

  it("decodes a percent-escaped parameter name before matching", () => {
    // `%61ccess_token` is `access_token` to everything downstream.
    expect(
      reason(() => assertNoForbiddenParams("https://x.test/?%61ccess_token=v")),
    ).toBe("forbidden_parameter");
  });

  it("sees through a leading router slash", () => {
    expect(
      reason(() => assertNoForbiddenParams("https://x.test/#/token=v")),
    ).toBe("forbidden_parameter");
  });

  it("never names the offending parameter in the message", () => {
    try {
      assertNoForbiddenParams("https://x.test/?access_token=sekret-value");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(InteractionLinkError);
      /* SAFETY: the assertion on the line above has checked the instance;
         `InteractionLinkError` extends `Error`, so `message` is present by that
         class contract and this reads the very string under test. */
      expect((error as Error).message).not.toContain("sekret-value");
      /* SAFETY: the same checked instance, read again — the refusal must name
         neither the value nor the parameter. */
      expect((error as Error).message).not.toContain("access_token");
    }
  });
});

describe("parseInteractionUrl", () => {
  it("round-trips a link the builder produced", () => {
    expect(
      parseInteractionUrl(buildInteractionUrl("https://x.test", REF)),
    ).toEqual({
      origin: "https://x.test",
      ref: REF,
    });
    expect(
      parseInteractionUrl(buildInteractionUrl("http://127.0.0.1:8788", REF)),
    ).toEqual({ origin: "http://127.0.0.1:8788", ref: REF });
    expect(
      parseInteractionUrl(
        buildInteractionUrl("https://x.test/OpenSesame", REF),
      ),
    ).toEqual({ origin: "https://x.test", ref: REF });
  });

  it("returns null, never throws, for hostile input", () => {
    const hostile = [
      "javascript:alert(1)",
      `javascript:/i/${REF}`,
      "//evil/i/x",
      `//evil/i/${REF}`,
      `https://x.test/i/${REF}/../admin`,
      "https://x.test/i/..%2F..%2Fadmin",
      "https://x.test/i/../../etc/passwd",
      "",
      "x".repeat(10240),
      `https://x.test/i/${REF}?a=b`,
      `https://x.test/i/${REF}#a`,
      `https://u:p@x.test/i/${REF}`,
      `http://evil.example/i/${REF}`,
      `https://x.test/${REF}`,
      "https://x.test/i/",
    ];
    for (const value of hostile) {
      expect(() => parseInteractionUrl(value)).not.toThrow();
      expect(parseInteractionUrl(value)).toBeNull();
    }
  });
});

describe("legacy links", () => {
  it("normalizes all four historical shapes to a user code", () => {
    expect(
      parseLegacyInteractionLink(
        "https://ceremonies.example/device?user_code=abcd-efgh",
      ),
    ).toEqual({ userCode: "ABCD-EFGH" });
    expect(
      parseLegacyInteractionLink("https://m.example/?code=wxyz-1234"),
    ).toEqual({
      userCode: "WXYZ-1234",
    });
    expect(
      parseLegacyInteractionLink("opensesame://invoke/mfa?user_code=abcd-1234"),
    ).toEqual({ userCode: "ABCD-1234" });
    expect(
      parseLegacyInteractionLink(
        "opensesame-mfa://approve?user_code=%20abcd-1234%20",
      ),
    ).toEqual({ userCode: "ABCD-1234" });
  });

  it("refuses a legacy link that carries credential material", () => {
    expect(
      reason(() => {
        parseLegacyInteractionLink("https://m.example/?token=osc_clm_abc.def");
      }),
    ).toBe("forbidden_parameter");
    expect(
      reason(() => {
        parseLegacyInteractionLink(
          "opensesame-mfa://approve?user_code=A#access_token=x",
        );
      }),
    ).toBe("forbidden_parameter");
  });

  it("returns null for anything that is not one of the four", () => {
    for (const value of [
      "",
      "not a url",
      "opensesame://other/route?user_code=ABCD",
      "opensesame-mfa://deny?user_code=ABCD",
      "wallet://approve?user_code=ABCD",
      "https://m.example/?user_code=",
      "https://m.example/?user_code=%20%20",
      "https://m.example/",
      `https://m.example/?user_code=${"A".repeat(65)}`,
      "https://m.example/?user_code=has%20space",
      "https://m.example/?user_code=<script>",
    ]) {
      expect(parseLegacyInteractionLink(value)).toBeNull();
    }
  });
});
