import { describe, expect, it } from "vitest";
import {
  OriginError,
  canonicalizeOrigin,
  defaultCallbackUri,
  originClientId,
  parseOriginClientId,
} from "../origin/canonical.js";

const PROD = { production: true } as const;
const DEV_LOOPBACK = { allowLoopbackHttp: true, production: false } as const;

describe("canonicalizeOrigin", () => {
  it("lowercases host and strips default https port", () => {
    expect(canonicalizeOrigin("https://App.Example.COM:443", PROD)).toBe(
      "https://app.example.com",
    );
  });

  it("strips default http port on loopback", () => {
    expect(canonicalizeOrigin("http://127.0.0.1:80", DEV_LOOPBACK)).toBe(
      "http://127.0.0.1",
    );
  });

  it("keeps non-default ports", () => {
    expect(canonicalizeOrigin("https://app.example.com:8443", PROD)).toBe(
      "https://app.example.com:8443",
    );
  });

  it("treats distinct ports as distinct origins", () => {
    const a = canonicalizeOrigin("http://127.0.0.1:4101", DEV_LOOPBACK);
    const b = canonicalizeOrigin("http://127.0.0.1:4102", DEV_LOOPBACK);
    expect(a).toBe("http://127.0.0.1:4101");
    expect(b).toBe("http://127.0.0.1:4102");
    expect(a).not.toBe(b);
  });

  it("allows loopback http only when opted in and not production", () => {
    expect(canonicalizeOrigin("http://127.0.0.1:4101", DEV_LOOPBACK)).toBe(
      "http://127.0.0.1:4101",
    );
    expect(canonicalizeOrigin("http://localhost:4101", DEV_LOOPBACK)).toBe(
      "http://localhost:4101",
    );
    expect(canonicalizeOrigin("http://[::1]:4101", DEV_LOOPBACK)).toBe(
      "http://[::1]:4101",
    );
  });

  it("rejects loopback http in production", () => {
    expect(() =>
      canonicalizeOrigin("http://127.0.0.1:4101", {
        allowLoopbackHttp: true,
        production: true,
      }),
    ).toThrow(OriginError);
    expect(() =>
      canonicalizeOrigin("http://127.0.0.1:4101", {
        allowLoopbackHttp: true,
        production: true,
      }),
    ).toThrow(/http/i);
  });

  it("rejects loopback http without the opt-in flag", () => {
    expect(() =>
      canonicalizeOrigin("http://127.0.0.1:4101", { production: false }),
    ).toThrow(OriginError);
  });

  it("rejects non-loopback http even with the opt-in flag", () => {
    expect(() =>
      canonicalizeOrigin("http://app.example.com", {
        allowLoopbackHttp: true,
        production: false,
      }),
    ).toThrow(OriginError);
  });

  it("rejects userinfo, query, path, fragment", () => {
    expect(() => canonicalizeOrigin("https://u:p@app.example.com")).toThrow(
      /userinfo/i,
    );
    expect(() => canonicalizeOrigin("https://app.example.com?x=1")).toThrow(
      /query/i,
    );
    expect(() => canonicalizeOrigin("https://app.example.com/path")).toThrow(
      /path/i,
    );
    expect(() => canonicalizeOrigin("https://app.example.com#x")).toThrow(
      /fragment/i,
    );
  });

  it("rejects non-web schemes", () => {
    for (const input of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "ftp://app.example.com",
    ]) {
      expect(() => canonicalizeOrigin(input)).toThrow(OriginError);
    }
    // ftp:// parses with a bare "/" path, so it reaches the scheme check.
    expect(() => canonicalizeOrigin("ftp://app.example.com")).toThrow(
      /scheme/i,
    );
  });

  it("rejects empty and malformed input", () => {
    expect(() => canonicalizeOrigin("")).toThrow(OriginError);
    expect(() => canonicalizeOrigin("   ")).toThrow(OriginError);
    expect(() => canonicalizeOrigin("not a url")).toThrow(OriginError);
  });

  it("accepts a bare trailing slash as no path", () => {
    expect(canonicalizeOrigin("https://app.example.com/", PROD)).toBe(
      "https://app.example.com",
    );
  });
});

describe("origin client id helpers", () => {
  it("builds origin client id and callback", () => {
    const o = "https://app.example.com";
    expect(originClientId(o)).toBe("origin:https://app.example.com");
    expect(defaultCallbackUri(o)).toBe(
      "https://app.example.com/opensesame/callback",
    );
  });

  it("parses origin client ids round-trip and rejects foreign ids", () => {
    expect(parseOriginClientId("origin:https://app.example.com")).toBe(
      "https://app.example.com",
    );
    expect(parseOriginClientId("app_123")).toBeUndefined();
  });
});
