import { describe, expect, it } from "vitest";
import { decodeJwtEnvelope } from "./jwt-envelope.js";

const part = (json: string) => Buffer.from(json).toString("base64url");
describe("untrusted JWT envelope syntax", () => {
  it("preserves UTF-8 without claiming signature validity", () => {
    expect(
      decodeJwtEnvelope(
        `${part('{"alg":"none"}')}.${part('{"sub":"λ"}')}.unverified`,
      ).claims.sub,
    ).toBe("λ");
  });
  it("refuses malformed, non-object and oversized input before use", () => {
    for (const token of [
      "",
      "a.b",
      "a.b.c.d",
      `${part("{}")}.${part("[]")}.x`,
      `${part("null")}.${part("{}")}.x`,
      "e30._w.x",
      "a".repeat(16385),
    ]) {
      expect(() => decodeJwtEnvelope(token)).toThrow();
    }
  });
});
