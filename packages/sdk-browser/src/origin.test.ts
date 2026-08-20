import { canonicalizeOrigin } from "@opensesame/oauth-provider/origin/canonical";
import { describe, expect, it } from "vitest";
import {
  BrowserOriginError,
  OriginError,
  assertSafeReturnTo,
  canonicalizeBrowserOrigin,
  defaultOriginCallback,
  originProfileClientId,
} from "./origin.js";

const PROD = { production: true } as const;
const DEV_LOOPBACK = { allowLoopbackHttp: true, production: false } as const;

/**
 * Symmetric with `packages/oauth-provider/src/__tests__/canonical.test.ts`
 * (ADR 0050 F1/DD3). Both sides call the same `canonicalizeOrigin`.
 */
const SHARED_VECTORS: Array<{
  input: string;
  options: { production?: boolean; allowLoopbackHttp?: boolean };
  output: string;
}> = [
  {
    input: "https://App.Example.COM:443",
    options: PROD,
    output: "https://app.example.com",
  },
  {
    input: "http://127.0.0.1:80",
    options: DEV_LOOPBACK,
    output: "http://127.0.0.1",
  },
  {
    input: "https://app.example.com:8443",
    options: PROD,
    output: "https://app.example.com:8443",
  },
  {
    input: "http://127.0.0.1:4101",
    options: DEV_LOOPBACK,
    output: "http://127.0.0.1:4101",
  },
  {
    input: "http://127.0.0.1:4102",
    options: DEV_LOOPBACK,
    output: "http://127.0.0.1:4102",
  },
  {
    input: "https://app.example.com/",
    options: PROD,
    output: "https://app.example.com",
  },
];

describe("canonicalizeOrigin symmetry", () => {
  it("matches the issuer for every shared vector", () => {
    for (const row of SHARED_VECTORS) {
      expect(canonicalizeOrigin(row.input, row.options)).toBe(row.output);
      if (row.input.startsWith("https") || row.options.allowLoopbackHttp) {
        expect(canonicalizeBrowserOrigin(row.input)).toBe(row.output);
      }
    }
  });

  it("treats distinct ports as distinct origins", () => {
    expect(canonicalizeBrowserOrigin("http://127.0.0.1:4101")).not.toBe(
      canonicalizeBrowserOrigin("http://127.0.0.1:4102"),
    );
  });
});

describe("canonicalizeBrowserOrigin", () => {
  it("normalizes https origins", () => {
    expect(canonicalizeBrowserOrigin("https://Example.com:443/")).toBe(
      "https://example.com",
    );
  });

  it("allows http on loopback", () => {
    expect(canonicalizeBrowserOrigin("http://127.0.0.1:5174")).toBe(
      "http://127.0.0.1:5174",
    );
    expect(canonicalizeBrowserOrigin("http://localhost")).toBe(
      "http://localhost",
    );
  });

  it("rejects http on non-loopback hosts", () => {
    expect(() => canonicalizeBrowserOrigin("http://example.com")).toThrow(
      OriginError,
    );
  });

  it("rejects origins with path or query", () => {
    expect(() => canonicalizeBrowserOrigin("https://example.com/app")).toThrow(
      OriginError,
    );
    expect(() => canonicalizeBrowserOrigin("https://example.com?x=1")).toThrow(
      OriginError,
    );
  });
});

describe("originProfileClientId", () => {
  it("prefixes canonical origin", () => {
    expect(originProfileClientId("https://app.example.com")).toBe(
      "origin:https://app.example.com",
    );
  });
});

describe("defaultOriginCallback", () => {
  it("uses /opensesame/callback path", () => {
    expect(defaultOriginCallback("http://127.0.0.1:5174")).toBe(
      "http://127.0.0.1:5174/opensesame/callback",
    );
  });
});

describe("assertSafeReturnTo", () => {
  it("accepts same-origin relative paths", () => {
    expect(assertSafeReturnTo("/dashboard")).toBe("/dashboard");
    expect(assertSafeReturnTo("/app/settings?tab=1")).toBe(
      "/app/settings?tab=1",
    );
  });

  it("rejects protocol-relative, absolute, and backslash tricks", () => {
    expect(() => assertSafeReturnTo("//evil.com")).toThrow(BrowserOriginError);
    expect(() => assertSafeReturnTo("https://evil.com")).toThrow(
      BrowserOriginError,
    );
    expect(() => assertSafeReturnTo("\\evil")).toThrow(BrowserOriginError);
    expect(() => assertSafeReturnTo("javascript:alert(1)")).toThrow(
      BrowserOriginError,
    );
  });
});
