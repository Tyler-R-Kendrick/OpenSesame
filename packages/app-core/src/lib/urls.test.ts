import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialsFor,
  isLoopbackUrl,
  isSameOrigin,
  normalizeApiBase,
  normalizeTailnetBase,
} from "./urls.js";

describe("api base fences", () => {
  it("tells this machine apart from everywhere else", () => {
    for (const local of [
      "http://127.0.0.1:8787",
      "http://127.9.9.9:8787",
      "http://localhost:8788",
      "http://[::1]:8787",
      "http://app.localhost/",
    ]) {
      expect(isLoopbackUrl(local)).toBe(true);
    }
    for (const remote of [
      "https://api.example",
      "http://10.0.0.5",
      "not-a-url",
    ]) {
      expect(isLoopbackUrl(remote)).toBe(false);
    }
  });

  it("takes only a base it would let a token travel to", () => {
    expect(normalizeApiBase("https://api.example.test/base/")).toBe(
      "https://api.example.test/base",
    );
    expect(normalizeApiBase("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    // Cleartext off the machine, other schemes, embedded credentials, nonsense.
    expect(normalizeApiBase("http://api.example.test")).toBeNull();
    expect(normalizeApiBase("ftp://127.0.0.1")).toBeNull();
    expect(normalizeApiBase("http://user:pw@127.0.0.1:8787")).toBeNull();
    expect(normalizeApiBase("   ")).toBeNull();
    // A base carrying a query or fragment would swallow every path joined to it.
    expect(
      normalizeApiBase("https://api.example.test/?next=http://evil.example"),
    ).toBeNull();
    expect(normalizeApiBase("https://api.example.test/#x")).toBeNull();
  });

  it("lets a tailnet name through without opening the rest of the LAN", () => {
    expect(normalizeTailnetBase("https://box.tail.ts.net")).toBe(
      "https://box.tail.ts.net",
    );
    expect(normalizeTailnetBase("http://opensesame:18790")).toBe(
      "http://opensesame:18790",
    );
    expect(normalizeTailnetBase("http://192.168.1.9:18790")).toBeNull();
  });
});

describe("tailnet base fence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects credentials, queries, fragments, and non-http(s) schemes", () => {
    expect(normalizeTailnetBase("ftp://box.tail.ts.net")).toBeNull();
    expect(normalizeTailnetBase("https://user:pw@box.tail.ts.net")).toBeNull();
    expect(normalizeTailnetBase("https://box.tail.ts.net/?x=1")).toBeNull();
    expect(normalizeTailnetBase("https://box.tail.ts.net/#frag")).toBeNull();
    // Plain https is fine anywhere — the generic API-base fence accepts it.
    expect(normalizeTailnetBase("https://evil.example")).toBe(
      "https://evil.example",
    );
    expect(normalizeTailnetBase("::not a url::")).toBeNull();
    expect(normalizeTailnetBase("")).toBeNull();
  });

  it("sends ambient credentials only to this page's own origin", () => {
    vi.stubGlobal("location", {
      href: "https://me.github.io/OpenSesame/",
      origin: "https://me.github.io",
    });
    expect(isSameOrigin("https://me.github.io/OpenSesame")).toBe(true);
    expect(isSameOrigin("https://other.example")).toBe(false);
    expect(credentialsFor("https://me.github.io/OpenSesame")).toBe("include");
    expect(credentialsFor("https://other.example")).toBe("omit");
  });

  it("treats an unparseable base as cross-origin", () => {
    vi.stubGlobal("location", { href: "::no base::", origin: "" });
    expect(isSameOrigin("https://me.github.io")).toBe(false);
  });

  it("treats a location-less runtime as cross-origin", () => {
    expect(isSameOrigin("https://me.github.io")).toBe(false);
    expect(credentialsFor("https://me.github.io")).toBe("omit");
  });
});
