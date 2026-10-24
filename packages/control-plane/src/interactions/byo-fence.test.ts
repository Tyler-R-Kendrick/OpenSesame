import { expect, it } from "vitest";
import { checkedByoIssuer } from "./byo-fence.js";
it.each([
  "",
  `https://idp.example${"/".repeat(200_000)}`,
  `https://idp.example${"/".repeat(200_000)}!`,
])("rejects invalid issuer input before registration (%j)", (issuer) => {
  expect(() => checkedByoIssuer(issuer)).toThrow();
});
it("normalizes a legitimate BYO issuer", () => {
  expect(checkedByoIssuer(" https://idp.example/// ")).toBe(
    "https://idp.example",
  );
});
