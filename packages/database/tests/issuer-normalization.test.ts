import { expect, it } from "vitest";
import { normalizeIssuer } from "../src/repos/interfaces.js";
it("normalizes valid issuers and preserves malformed non-suffix slashes", () => {
  expect(normalizeIssuer(" https://idp.example/// ")).toBe(
    "https://idp.example",
  );
  expect(normalizeIssuer(`https://idp.example${"/".repeat(200_000)}`)).toBe(
    "https://idp.example",
  );
  const malformed = `https://idp.example${"/".repeat(200_000)}!`;
  expect(normalizeIssuer(malformed)).toBe(malformed);
});
