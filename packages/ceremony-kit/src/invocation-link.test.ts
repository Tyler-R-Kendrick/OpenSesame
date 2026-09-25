import { describe, expect, it } from "vitest";
import {
  AUTHENTICATOR_INVOCATION_KINDS,
  CEREMONY_ROUTES,
  ceremonyPath,
} from "./ceremony-routes.js";
import {
  INVOCATION_LABELS,
  INVOCATION_WORDS,
  invocationKindAt,
  readInvocationArrival,
} from "./invocation-link.js";

const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = "/OpenSesame";

function at(path: string): string {
  return `${ORIGIN}${BASE}${path}`;
}

describe("the invoke link reader", () => {
  it("hands an MFA user code to the app and names the /device fallback", () => {
    const read = readInvocationArrival(at("/invoke/mfa?user_code=abcd-1234"));
    expect(read.scrubbed).toBe(`${BASE}/invoke/mfa`);
    expect(read.arrival).toEqual({
      kind: "handoff",
      invocation: {
        kind: "mfa",
        handleName: "user_code",
        handle: "ABCD-1234",
        appUrl: "opensesame://invoke/mfa?user_code=ABCD-1234",
        browserFallback: `${ceremonyPath("device")}?user_code=ABCD-1234`,
        requestHost: null,
      },
    });
  });

  it("hands a request URI to the wallet scheme and offers no fallback", () => {
    const read = readInvocationArrival(
      at("/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Fr%2F1"),
    );
    expect(read.arrival.kind).toBe("handoff");
    if (read.arrival.kind !== "handoff") return;
    expect(read.arrival.invocation.appUrl).toBe(
      "openid4vp://?request_uri=https%3A%2F%2Fverifier.example%2Fr%2F1",
    );
    expect(read.arrival.invocation.browserFallback).toBeNull();
    expect(read.arrival.invocation.requestHost).toBe("verifier.example");
  });

  it("refuses a kind the spec does not list, read raw", () => {
    for (const kind of ["totp", "MFA", "m%66a", "mfa%2Fx", "mfa.x"]) {
      const read = readInvocationArrival(at(`/invoke/${kind}?user_code=AB`));
      expect(read.arrival, kind).toEqual({
        kind: "refused",
        words: INVOCATION_WORDS.unknownKind,
      });
      expect(read.scrubbed, kind).toBe(`${BASE}/invoke/${kind}`);
    }
  });

  it("refuses what the parser refuses, in its words, and still scrubs", () => {
    const cases = [
      ["/invoke/mfa?user_code=A&request_id=B", "exactly one request handle"],
      ["/invoke/mfa?access_token=x", "credential material"],
      ["/invoke/mfa?utm_source=x", "unsupported parameter"],
      ["/invoke/oid4vci?request_uri=http%3A%2F%2Fx.example%2F", "HTTPS"],
      ["/invoke/mfa", "exactly one request handle"],
    ] as const;
    for (const [path, words] of cases) {
      const read = readInvocationArrival(at(path));
      expect(read.arrival.kind, path).toBe("refused");
      if (read.arrival.kind === "refused")
        expect(read.arrival.words, path).toContain(words);
    }
    expect(
      readInvocationArrival(at("/invoke/mfa?access_token=x")).scrubbed,
    ).toBe(`${BASE}/invoke/mfa`);
    expect(readInvocationArrival(at("/invoke/mfa")).scrubbed).toBeNull();
  });

  it("refuses a fragment the spec does not name, and an overlong link", () => {
    expect(
      readInvocationArrival(at("/invoke/mfa?user_code=AB#token=x")).arrival,
    ).toEqual({ kind: "refused", words: INVOCATION_WORDS.fragment });
    const long = at(`/invoke/mfa?user_code=${"A".repeat(2100)}`);
    expect(readInvocationArrival(long).arrival).toEqual({
      kind: "refused",
      words: INVOCATION_WORDS.tooLong,
    });
  });

  it("leaves every other address alone", () => {
    for (const href of [
      at("/device?user_code=AB"),
      at("/invoke"),
      at("/invoke/"),
      at("/invoke/oid4vci/callback?code=x"),
      at("/?code=x&state=y"),
      "opensesame://invoke/mfa?user_code=AB",
      "not a url",
    ]) {
      expect(readInvocationArrival(href), href).toEqual({
        arrival: { kind: "none" },
        scrubbed: null,
      });
    }
    expect(invocationKindAt("/invoke/mfa")).toBe("mfa");
    expect(invocationKindAt("/device")).toBeNull();
  });

  it("titles every kind the spec lists, and labels every handle name", () => {
    expect(Object.keys(INVOCATION_LABELS.title)).toEqual([
      ...AUTHENTICATOR_INVOCATION_KINDS,
    ]);
    const names = new Set(
      Object.values(CEREMONY_ROUTES.invoke.kinds ?? {}).flatMap((k) => k.query),
    );
    expect(Object.keys(INVOCATION_LABELS.handle).sort()).toEqual(
      [...names].sort(),
    );
  });
});
