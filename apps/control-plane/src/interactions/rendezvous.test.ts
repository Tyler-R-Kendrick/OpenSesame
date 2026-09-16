import { afterEach, describe, expect, it } from "vitest";
import {
  admitRequester,
  assertClientAppUrl,
  resetRequesterAdmission,
  resolveContinuation,
} from "./rendezvous.js";

const REF = `i_abc.${"a".repeat(32)}`;

afterEach(() => {
  resetRequesterAdmission();
});

describe("resolveContinuation", () => {
  it("is an address when no client app is configured", () => {
    expect(resolveContinuation({ ref: REF })).toEqual({ mode: "address" });
    expect(resolveContinuation({ clientAppUrl: "  ", ref: REF })).toEqual({
      mode: "address",
    });
  });

  it("launches into the client app, preserving its base path", () => {
    // A Pages-style deployment serves the PWA under `/OpenSesame/`; the
    // continuation must land under that prefix, not at the origin root.
    const withSlash = resolveContinuation({
      clientAppUrl: "https://app.example/OpenSesame/",
      ref: REF,
    });
    const withoutSlash = resolveContinuation({
      clientAppUrl: "https://app.example/OpenSesame",
      ref: REF,
    });
    const expected = {
      mode: "launcher" as const,
      url: `https://app.example/OpenSesame/i/${REF}`,
    };
    // A trailing slash and its absence are one deployment: one spelling out.
    expect(withSlash).toEqual(expected);
    expect(withoutSlash).toEqual(expected);
  });

  it("launches at the origin root when the base has no path", () => {
    expect(
      resolveContinuation({ clientAppUrl: "https://app.example", ref: REF }),
    ).toEqual({ mode: "launcher", url: `https://app.example/i/${REF}` });
  });

  it("allows http against a loopback host for local development", () => {
    expect(
      resolveContinuation({ clientAppUrl: "http://localhost:5180/", ref: REF }),
    ).toEqual({ mode: "launcher", url: `http://localhost:5180/i/${REF}` });
  });

  it("degrades to an address rather than throwing on a bad base", () => {
    // A scan must never 500 because an operator mistyped the client-app URL.
    for (const clientAppUrl of [
      "http://app.example/", // non-loopback plaintext
      "not a url",
      "https://user:pw@app.example/", // userinfo
      "https://app.example/?token=osc_abc", // credential material in a query
      "https://app.example/#access_token=leak", // and in a fragment
    ]) {
      expect(resolveContinuation({ clientAppUrl, ref: REF })).toEqual({
        mode: "address",
      });
    }
  });
});

describe("assertClientAppUrl", () => {
  it("accepts an https base with a path and returns it normalized", () => {
    const url = assertClientAppUrl("https://app.example/OpenSesame/", {
      requireHttps: true,
    });
    expect(url.origin).toBe("https://app.example");
    expect(url.pathname).toBe("/OpenSesame/");
  });

  it("refuses plaintext when https is required, even on loopback", () => {
    expect(() =>
      assertClientAppUrl("http://localhost:5180/", { requireHttps: true }),
    ).toThrow(/https/);
  });

  it("refuses a base that already carries a query or fragment", () => {
    expect(() =>
      assertClientAppUrl("https://app.example/?x=1", { requireHttps: false }),
    ).toThrow();
    expect(() =>
      assertClientAppUrl("https://app.example/#/route", {
        requireHttps: false,
      }),
    ).toThrow();
  });

  it("refuses a base carrying credential material", () => {
    // A base with a query is refused as a query before the param sweep even
    // runs; either way an operator cannot configure a bearer into the launcher.
    expect(() =>
      assertClientAppUrl("https://app.example/?id_token=leak", {
        requireHttps: false,
      }),
    ).toThrow();
  });
});

describe("admitRequester", () => {
  it("admits up to the budget in a window, then refuses", () => {
    const now = 1_000_000;
    let admitted = 0;
    for (let i = 0; i < 60; i += 1) {
      if (admitRequester("req_alice", now)) admitted += 1;
    }
    expect(admitted).toBe(60);
    expect(admitRequester("req_alice", now)).toBe(false);
  });

  it("paces one requester without paging another", () => {
    const now = 2_000_000;
    for (let i = 0; i < 60; i += 1) admitRequester("req_alice", now);
    expect(admitRequester("req_alice", now)).toBe(false);
    // A different requester's budget is untouched — one flooder cannot switch
    // the create route off for everyone.
    expect(admitRequester("req_bob", now)).toBe(true);
  });

  it("reopens the window as time passes", () => {
    const start = 3_000_000;
    for (let i = 0; i < 60; i += 1) admitRequester("req_alice", start);
    expect(admitRequester("req_alice", start)).toBe(false);
    // Past the sliding window, the earlier attempts have aged out.
    expect(admitRequester("req_alice", start + 60_001)).toBe(true);
  });
});
