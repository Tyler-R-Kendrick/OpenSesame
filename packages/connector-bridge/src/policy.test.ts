import { describe, expect, it } from "vitest";
import {
  allAuthorities,
  authoritiesOf,
  checkFetch,
  isNamedHost,
  oauthAuthoritiesOf,
  providerOfHost,
  responseHeaders,
  underTenantFamily,
} from "./policy.js";
import { MAX_HEADERS, MAX_REQUEST_BODY } from "./protocol.js";
import type { BridgeFetchRequest, HeaderPair } from "./protocol.js";

const table = [
  { providerId: "plivo", authorities: ["api.plivo.com"] },
  {
    providerId: "datadog",
    authorities: ["api.datadoghq.com", "api.datadoghq.eu"],
  },
] as const;
const granted = new Set(["api.plivo.com", "api.datadoghq.com"]);
const request = (
  change: Partial<BridgeFetchRequest> = {},
): BridgeFetchRequest => ({
  providerId: "plivo",
  url: "https://api.plivo.com/v1/Account/x/",
  method: "GET",
  headers: [["Authorization", "Basic abc"]],
  body: null,
  ...change,
});

describe("checkFetch", () => {
  it("lets a well formed request to an allowed host through, with lower-cased header names", () => {
    const verdict = checkFetch(request(), table, granted);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.url.hostname).toBe("api.plivo.com");
      expect(verdict.headers).toEqual([["authorization", "Basic abc"]]);
    }
  });

  it.each([
    ["http", "http://api.plivo.com/v1/", "bad_request"],
    ["a port", "https://api.plivo.com:8443/v1/", "bad_request"],
    [
      "credentials in the address",
      "https://user:pw@api.plivo.com/v1/",
      "bad_request",
    ],
    ["a fragment", "https://api.plivo.com/v1/#x", "bad_request"],
    ["not an address", "not a url", "bad_request"],
    [
      "another provider's host",
      "https://api.datadoghq.com/api/v1/validate",
      "host_not_allowed",
    ],
    [
      "a look-alike host",
      "https://api.plivo.com.evil.test/v1/",
      "host_not_allowed",
    ],
    ["a sub-domain", "https://x.api.plivo.com/v1/", "host_not_allowed"],
    ["a host nobody named", "https://evil.test/", "host_not_allowed"],
  ])("refuses %s", (_name, url, code) => {
    expect(checkFetch(request({ url }), table, granted)).toEqual({
      ok: false,
      code,
    });
  });

  it("refuses a host a person has not allowed, though the table names it", () => {
    expect(
      checkFetch(
        request({ providerId: "datadog", url: "https://api.datadoghq.eu/x" }),
        table,
        granted,
      ),
    ).toEqual({ ok: false, code: "not_granted" });
  });

  it("refuses a provider the table does not know", () => {
    expect(checkFetch(request({ providerId: "nope" }), table, granted)).toEqual(
      {
        ok: false,
        code: "host_not_allowed",
      },
    );
  });

  it("refuses a body on a GET or HEAD, and one that is too large", () => {
    expect(checkFetch(request({ body: "x" }), table, granted)).toEqual({
      ok: false,
      code: "bad_request",
    });
    expect(
      checkFetch(request({ method: "HEAD", body: "x" }), table, granted),
    ).toEqual({ ok: false, code: "bad_request" });
    expect(
      checkFetch(
        request({ method: "POST", body: "a".repeat(MAX_REQUEST_BODY + 1) }),
        table,
        granted,
      ),
    ).toEqual({ ok: false, code: "too_large" });
    expect(
      checkFetch(request({ method: "POST", body: "{}" }), table, granted).ok,
    ).toBe(true);
  });

  it.each([
    "Cookie",
    "Host",
    "Origin",
    "Referer",
    "Content-Length",
    "User-Agent",
    "Sec-Fetch-Mode",
    "Proxy-Authorization",
    "Transfer-Encoding",
  ])(
    "denies the header %s, which a browser would not let a page set",
    (name) => {
      expect(
        checkFetch(request({ headers: [[name, "x"]] }), table, granted),
      ).toEqual({
        ok: false,
        code: "denied_header",
      });
    },
  );

  it.each([
    ["a name with a space", [["bad name", "x"]]],
    ["a name with a colon", [["a:b", "x"]]],
    ["a value with a newline", [["x-a", "a\nb"]]],
    ["a value with a NUL", [["x-a", "a\u0000b"]]],
    [
      "a repeated name",
      [
        ["x-a", "1"],
        ["X-A", "2"],
      ],
    ],
    [
      "too many headers",
      Array.from({ length: MAX_HEADERS + 1 }, (_, i) => [`x-${i}`, "v"]),
    ],
  ] satisfies [string, HeaderPair[]][])("refuses %s", (_name, headers) => {
    expect(checkFetch(request({ headers }), table, granted)).toEqual({
      ok: false,
      code: "bad_request",
    });
  });
});

describe("the table", () => {
  it("names a provider's hosts, and every host once", () => {
    expect(authoritiesOf(table, "datadog")).toEqual([
      "api.datadoghq.com",
      "api.datadoghq.eu",
    ]);
    expect(authoritiesOf(table, "nope")).toEqual([]);
    expect(allAuthorities(table)).toEqual([
      "api.datadoghq.com",
      "api.datadoghq.eu",
      "api.plivo.com",
    ]);
  });
});

describe("responseHeaders", () => {
  it("passes headers through lower-cased and never a cookie", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Retry-After": "3",
    });
    headers.append("Set-Cookie", "a=b");
    expect(responseHeaders(headers)).toEqual([
      ["content-type", "application/json"],
      ["retry-after", "3"],
    ]);
  });
});

describe("OAuth hosts and tenant families (ADR 0218)", () => {
  const oauthTable = [
    { providerId: "zoom", authorities: [], oauth: ["zoom.us", "api.zoom.us"] },
    { providerId: "okta", authorities: [], tenants: ["*.okta.com"] },
  ] as const;
  const tokenRequest = (change: Partial<BridgeFetchRequest> = {}) =>
    request({
      providerId: "zoom",
      url: "https://zoom.us/oauth/token",
      method: "POST",
      headers: [["content-type", "application/x-www-form-urlencoded"]],
      body: "grant_type=authorization_code&code=x",
      ...change,
    });

  it("sends a registered application's token request to an OAuth host a person allowed", () => {
    expect(
      checkFetch(tokenRequest(), oauthTable, new Set(["zoom.us"])).ok,
    ).toBe(true);
  });

  it("keeps OAuth hosts out of the API-key list and names them separately", () => {
    expect(authoritiesOf(oauthTable, "zoom")).toEqual([]);
    expect(oauthAuthoritiesOf(oauthTable, "zoom")).toEqual([
      "zoom.us",
      "api.zoom.us",
    ]);
    expect(allAuthorities(oauthTable)).toEqual(["api.zoom.us", "zoom.us"]);
  });

  it("refuses an OAuth host for another provider and one a person did not allow", () => {
    const verdict = (change: Partial<BridgeFetchRequest>, held: string[]) =>
      checkFetch(tokenRequest(change), oauthTable, new Set(held));
    expect(verdict({ providerId: "okta" }, ["zoom.us"])).toEqual({
      ok: false,
      code: "host_not_allowed",
    });
    expect(verdict({}, ["api.zoom.us"])).toEqual({
      ok: false,
      code: "not_granted",
    });
  });

  it("lets a tenant under a named family be called once allowed, and nothing else", () => {
    const tenant = (url: string, held: string[]) =>
      checkFetch(
        request({ providerId: "okta", url, method: "GET" }),
        oauthTable,
        new Set(held),
      );
    expect(
      tenant("https://acme.okta.com/oauth2/v1/token", ["acme.okta.com"]).ok,
    ).toBe(true);
    expect(tenant("https://acme.okta.com/x", [])).toEqual({
      ok: false,
      code: "not_granted",
    });
    for (const url of [
      "https://okta.com/x",
      "https://evilokta.com/x",
      "https://acme.okta.com.evil.test/x",
      "https://acme.okta.com./x",
      "https://-.okta.com/x",
    ])
      expect(tenant(url, [new URL(url).hostname])).toEqual({
        ok: false,
        code: "host_not_allowed",
      });
  });

  it("names a tenant host only under its family, for the one provider that owns the family", () => {
    expect(isNamedHost(oauthTable, "acme.okta.com")).toBe(true);
    expect(isNamedHost(oauthTable, "a.b.okta.com")).toBe(true);
    expect(isNamedHost(oauthTable, "okta.com")).toBe(false);
    expect(providerOfHost(oauthTable, "acme.okta.com")).toBe("okta");
    expect(providerOfHost(oauthTable, "zoom.us")).toBe("zoom");
    expect(providerOfHost(oauthTable, "evil.test")).toBeNull();
  });

  it("matches a family by labels, not by text", () => {
    expect(underTenantFamily("acme.okta.com", "*.okta.com")).toBe(true);
    expect(underTenantFamily("acme.okta.com", "okta.com")).toBe(false);
    expect(underTenantFamily("xokta.com", "*.okta.com")).toBe(false);
    expect(underTenantFamily(".okta.com", "*.okta.com")).toBe(false);
    expect(underTenantFamily("a..okta.com", "*.okta.com")).toBe(false);
  });
});
