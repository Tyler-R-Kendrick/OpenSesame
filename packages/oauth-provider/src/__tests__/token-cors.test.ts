import { describe, expect, it } from "vitest";
import { evaluateTokenCors } from "../cors/token-cors.js";

describe("evaluateTokenCors", () => {
  it("allows exact origin match and reflects the stored origin only", () => {
    const d = evaluateTokenCors(
      "https://app.example.com",
      "https://app.example.com",
    );
    expect(d.allowed).toBe(true);
    expect(d.allowOrigin).toBe("https://app.example.com");
    expect(d.headers["Access-Control-Allow-Origin"]).toBe(
      "https://app.example.com",
    );
    expect(d.headers.Vary).toBe("Origin");
    expect(d.headers["Cache-Control"]).toBe("no-store");
    expect(d.headers.Pragma).toBe("no-cache");
  });

  it("denies a mismatched origin with no ACAO header (never reflects)", () => {
    const d = evaluateTokenCors(
      "https://evil.example",
      "https://app.example.com",
    );
    expect(d.allowed).toBe(false);
    expect(d.allowOrigin).toBeUndefined();
    expect(d.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // Fail-closed headers are still emitted so caches key on Origin.
    expect(d.headers.Vary).toBe("Origin");
  });

  it("denies missing and null origins with no ACAO header", () => {
    for (const origin of [null, undefined, "null", ""]) {
      const d = evaluateTokenCors(origin, "https://app.example.com");
      expect(d.allowed).toBe(false);
      expect(d.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    }
  });

  it("denies when the client has no persisted canonical origin", () => {
    const d = evaluateTokenCors("https://app.example.com", undefined);
    expect(d.allowed).toBe(false);
    expect(d.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("is byte-exact: case, port, and trailing differences all deny", () => {
    const stored = "https://app.example.com";
    for (const origin of [
      "https://App.example.com",
      "https://app.example.com:443",
      "https://app.example.com:8443",
      "http://app.example.com",
      "https://app.example.com.evil.example",
    ]) {
      expect(evaluateTokenCors(origin, stored).allowed).toBe(false);
    }
  });

  it("never emits wildcard", () => {
    const d = evaluateTokenCors(
      "https://app.example.com",
      "https://app.example.com",
    );
    expect(JSON.stringify(d.headers)).not.toContain("*");
  });
});
