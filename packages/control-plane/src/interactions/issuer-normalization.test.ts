import { expect, it } from "vitest";
import { normalizeIssuer } from "./issuer-normalization.js";

it("normalizes issuers with linear suffix scans", () => {
  expect(normalizeIssuer("  https://idp.example///  ")).toBe(
    "https://idp.example",
  );
  const malformed = `https://idp.example/${"/".repeat(200_000)}!`;
  expect(normalizeIssuer(malformed)).toBe(malformed);
  expect(normalizeIssuer(`https://idp.example${"/".repeat(200_000)}`)).toBe(
    "https://idp.example",
  );
});
