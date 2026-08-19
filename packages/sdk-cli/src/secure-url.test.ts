import { describe, expect, it } from "vitest";
import {
  assertDiscoveredUrl,
  assertDiscoveryBelongsToIssuer,
  assertSecureUrl,
  trimSlash,
} from "./secure-url.js";

describe("secure URL boundary", () => {
  it.each([
    "https://idp.example/path",
    "http://localhost:8788",
    "http://sub.localhost:8788",
    "http://127.0.0.1:8788",
    "http://127.255.255.255:8788",
    "http://[::1]:8788",
    "http://[::ffff:127.0.0.1]:8788",
    "http://[::ffff:7f00:1]:8788",
    "http://[::7f00:1]:8788",
  ])("accepts encrypted or loopback URL %s", (url) => {
    expect(assertSecureUrl(url, "endpoint")).toBe(url);
  });

  it.each([
    "http://idp.example",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "ftp://127.0.0.1/resource",
  ])("refuses insecure URL %s", (url) => {
    expect(() => assertSecureUrl(url, "endpoint")).toThrow(
      /endpoint must use https/u,
    );
  });

  it("names malformed absolute URLs", () => {
    expect(() => assertSecureUrl("not a url", "issuer")).toThrow(
      "issuer must be an absolute URL",
    );
  });

  it.each([
    "https://0.0.0.0/token",
    "https://[::]/token",
    "https://127.0.0.1/token",
    "https://10.0.0.1/token",
    "https://169.254.1.2/token",
    "https://172.16.0.1/token",
    "https://172.31.255.255/token",
    "https://192.168.1.2/token",
    "https://[::ffff:0a00:1]/token",
    "https://[::ffff:192.168.1.2]/token",
    "https://[::ffff:0:1]/token",
    "https://[::a00:1]/token",
    "https://[fc00::1]/token",
    "https://[fd00::1]/token",
    "https://[fe80::1]/token",
    "https://service.internal/token",
    "https://service.local/token",
  ])("remote issuers cannot redirect to private endpoint %s", (endpoint) => {
    expect(() =>
      assertDiscoveredUrl(endpoint, "token_endpoint", "https://idp.example"),
    ).toThrow(/private or loopback host/u);
  });

  it.each([
    "https://8.8.8.8/token",
    "https://11.0.0.1/token",
    "https://169.253.1.2/token",
    "https://172.15.255.255/token",
    "https://172.32.0.1/token",
    "https://192.169.0.1/token",
    "https://[fe70::1]/token",
    "https://[::ffff:808:808]/token",
    "https://service.local.example/token",
    "https://11.254.168.1/token",
    "https://128.254.168.1/token",
    "https://168.254.168.1/token",
    "https://173.16.168.1/token",
    "https://193.168.1.1/token",
    "https://[fbff::1]/token",
    "https://[fec0::1]/token",
  ])("remote issuers may use public endpoint %s", (endpoint) => {
    expect(
      assertDiscoveredUrl(endpoint, "token_endpoint", "https://idp.example"),
    ).toBe(endpoint);
  });

  it("allows private discovery only for a private issuer", () => {
    expect(
      assertDiscoveredUrl(
        "http://127.0.0.1:8788/token",
        "token_endpoint",
        "http://localhost:8788",
      ),
    ).toBe("http://127.0.0.1:8788/token");
    expect(() =>
      assertDiscoveredUrl(
        "https://idp.example/token",
        "token_endpoint",
        "not a url",
      ),
    ).toThrow("issuer must be an absolute URL");
  });

  it("normalizes trailing slashes only and binds discovery issuer exactly", () => {
    expect(trimSlash("https://idp.example///")).toBe("https://idp.example");
    expect(trimSlash("https://idp.example/path")).toBe(
      "https://idp.example/path",
    );
    expect(trimSlash("")).toBe("");
    expect(() =>
      assertDiscoveryBelongsToIssuer({}, "https://idp.example"),
    ).toThrow(/does not match/u);
    expect(() =>
      assertDiscoveryBelongsToIssuer({}, "Stryker was here!"),
    ).toThrow(/does not match/u);
    expect(() =>
      assertDiscoveryBelongsToIssuer(
        { issuer: "https://other.example" },
        "https://idp.example",
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      assertDiscoveryBelongsToIssuer(
        { issuer: "https://idp.example/" },
        "https://idp.example",
      ),
    ).not.toThrow();
  });
});
